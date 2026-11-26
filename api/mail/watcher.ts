import { ImapFlow } from "imapflow";
import { decryptSecret } from "../lib/crypto";
import { log } from "../lib/logger";
import { getDb } from "../queries/connection";
import * as schema from "@db/schema";
import { eq } from "drizzle-orm";
import { listRulesForAccount } from "../queries/rules";
import { runRulesOnMessages } from "./engine";
import { fetchMessagesByUid } from "./imap";
import type { MailAccount } from "@db/schema";

/**
 * 邮箱实时监控：每账号一条 IMAP 长连接（auto-IDLE），新邮件到达时
 * 1) 向所有 SSE 订阅者推送新邮件摘要
 * 2) 通过独立连接拉取新邮件并自动执行分拣规则
 * 连接断开自动重连（15 秒退避），最后一个订阅者离开后 30 秒回收。
 */

export type WatcherEvent =
  | { type: "ready"; accountId: number }
  | { type: "mail"; accountId: number; messages: Awaited<ReturnType<typeof fetchMessagesByUid>> }
  | { type: "triage"; accountId: number; matched: number; errors: string[] }
  | { type: "error"; accountId: number; message: string };

type Listener = (evt: WatcherEvent) => void;

interface Watcher {
  listeners: Set<Listener>;
  stopFlag: boolean;
  client: ImapFlow | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<number, Watcher>();

export function subscribeMail(accountId: number, listener: Listener): () => void {
  let w = watchers.get(accountId);
  if (!w) {
    w = { listeners: new Set(), stopFlag: false, client: null, idleTimer: null };
    watchers.set(accountId, w);
    void runWatcherLoop(accountId, w).catch(() => {});
  }
  if (w.idleTimer) {
    clearTimeout(w.idleTimer);
    w.idleTimer = null;
  }
  w.listeners.add(listener);
  return () => {
    const cur = watchers.get(accountId);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size === 0 && !cur.idleTimer) {
      cur.idleTimer = setTimeout(() => {
        const again = watchers.get(accountId);
        if (again && again.listeners.size === 0) void destroyWatcher(accountId);
      }, 30_000);
    }
  };
}

export async function stopWatcher(accountId: number): Promise<void> {
  await destroyWatcher(accountId);
}

async function destroyWatcher(accountId: number): Promise<void> {
  const w = watchers.get(accountId);
  if (!w) return;
  watchers.delete(accountId);
  w.stopFlag = true;
  if (w.idleTimer) clearTimeout(w.idleTimer);
  try {
    await w.client?.logout();
  } catch {
    /* ignore */
  }
}

function emit(w: Watcher, evt: WatcherEvent): void {
  for (const l of w.listeners) {
    try {
      l(evt);
    } catch {
      /* listener 失败不影响其他订阅者 */
    }
  }
}

/**
 * 初始水位（最新已存在邮件的 UID）。
 * 163/Coremail 的 SELECT 响应不带 UIDNEXT，需多级回退：
 * STATUS → SELECT 返回 → 抓取最高 UID → 0。
 */
async function initialWatermark(client: ImapFlow): Promise<number> {
  try {
    const st = await client.status("INBOX", { uidNext: true });
    if (typeof st.uidNext === "number" && st.uidNext > 0) return st.uidNext - 1;
  } catch {
    /* 服务器不支持 STATUS 时继续回退 */
  }
  return -1; // 由调用方在 mailboxOpen 后继续判定
}

async function loadAccount(accountId: number): Promise<MailAccount | null> {
  const rows = await getDb().select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, accountId));
  return rows.at(0) ?? null;
}

/** 防抖处理新邮件：拉取 → 推送 → 自动分拣 */
async function processNewMail(
  accountId: number,
  w: Watcher,
  account: MailAccount,
  sinceUid: number,
): Promise<number> {
  const news = await fetchMessagesByUid(account, "INBOX", sinceUid);
  if (news.length === 0 || w.stopFlag) return sinceUid;
  const maxUid = Math.max(...news.map((m) => m.uid));
  emit(w, { type: "mail", accountId, messages: news });
  try {
    const rows = await listRulesForAccount(account.userId, accountId);
    if (rows.length > 0) {
      const result = await runRulesOnMessages(account, rows, news);
      emit(w, { type: "triage", accountId, matched: result.matched, errors: result.errors });
    }
  } catch (err) {
    log.warn("auto triage failed", { accountId, error: String(err) });
  }
  return maxUid + 1;
}

async function runWatcherLoop(accountId: number, w: Watcher): Promise<void> {
  while (!w.stopFlag) {
    const account = await loadAccount(accountId);
    if (!account) return; // 账号已删除
    let client: ImapFlow | null = null;
    try {
      client = new ImapFlow({
        host: account.imapHost,
        port: account.imapPort,
        secure: account.imapSecure,
        auth: { user: account.authUser, pass: decryptSecret(account.passwordEnc) },
        logger: false,
        socketTimeout: 60_000,
        // IDLE 周期性重启，防服务器/中间盒静默断链
        maxIdleTime: 60_000,
      });
      await client.connect();
      let lastUid = await initialWatermark(client);
      const box = await client.mailboxOpen("INBOX");
      w.client = client;
      if (lastUid < 0) {
        if (typeof box.uidNext === "number" && box.uidNext > 0) {
          lastUid = box.uidNext - 1;
        } else {
          // 最后回退：取收件箱里 UID 最高的一封
          const last = await client.fetchOne("*", { uid: true }, { uid: true });
          const uid = (last as { uid?: number } | false)?.uid;
          lastUid = typeof uid === "number" ? uid : 0;
        }
      }
      log.info("watcher ready", { accountId, lastUid });
      emit(w, { type: "ready", accountId });

      let debounce: ReturnType<typeof setTimeout> | null = null;
      let processing = false;
      let pendingAgain = false;

      const kick = () => {
        if (debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          if (processing) {
            pendingAgain = true;
            return;
          }
          processing = true;
          processNewMail(accountId, w, account, lastUid + 1)
            .then((next) => {
              lastUid = Math.max(lastUid, next - 1);
            })
            .catch((err) => log.warn("process new mail failed", { accountId, error: String(err) }))
            .finally(() => {
              processing = false;
              if (pendingAgain) {
                pendingAgain = false;
                kick();
              }
            });
        }, 1_500);
      };

      client.on("exists", kick);

      // 挂起直到连接断开或停止
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (w.stopFlag || !client!.usable) {
            clearInterval(poll);
            resolve();
          }
        }, 1_000);
        client!.once("close", () => {
          clearInterval(poll);
          resolve();
        });
      });
      if (debounce) clearTimeout(debounce);
    } catch (err) {
      if (!w.stopFlag) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("mail watcher error", { accountId, error: msg });
        emit(w, { type: "error", accountId, message: msg });
      }
    } finally {
      w.client = null;
      if (client) {
        try {
          await client.logout();
        } catch {
          /* ignore */
        }
      }
    }
    if (!w.stopFlag) await new Promise((r) => setTimeout(r, 15_000));
  }
}
