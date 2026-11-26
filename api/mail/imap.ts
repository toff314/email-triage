import { ImapFlow, type ListResponse } from "imapflow";
import type { MailAccount } from "@db/schema";
import { decryptSecret } from "../lib/crypto";
import { log } from "../lib/logger";

/** 邮件摘要（列表/规则引擎共用） */
export interface MessageSummary {
  uid: number;
  folder: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  to: string[];
  cc: string[];
  date: Date;
  flags: string[];
  seen: boolean;
  starred: boolean;
  hasAttach: boolean;
  sizeKb: number;
  headers: Record<string, string>;
  snippet: string;
}

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  specialUse: string | null;
  children: FolderInfo[];
}

const IDLE_TTL_MS = 5 * 60 * 1000;

/** 系统/个人邮箱固有的文件夹，任何情况下都不许删 */
export const PROTECTED_FOLDERS = new Set(
  ["inbox", "sent", "drafts", "trash", "junk", "archive", "已发送", "已删除", "草稿", "垃圾箱", "垃圾邮件", "存档", "notes", "sent items", "deleted items", "垃圾", "发件箱",
    // 163 内置：智能分类（IMAP 可见但服务端禁止删除）+ 客户端删信（第三方客户端删的邮件的暂存箱）
    "广告邮件", "订阅邮件", "客户端删信"].map((s) => s.toLowerCase()),
);

/**
 * 把文件夹里残留的邮件全部移回收件箱（还原），返回移回的封数。
 * 用于删规则后的文件夹级联清理：先还原内容，再删空文件夹。
 */
export async function emptyFolderBackToInbox(
  account: MailAccount,
  folder: string,
): Promise<number> {
  const msgs = await fetchRecentMessages(account, folder, 1000);
  if (msgs.length === 0) return 0;
  await moveMessages(account, folder, msgs.map((m) => m.uid), "INBOX");
  return msgs.length;
}

/**
 * 仅当文件夹为空、且不在保护名单里时才删除。
 * 返回是否删除了。有邮件的文件夹 IMAP 服务端本就会拒绝，这里再前置一道 STATUS 检查。
 */
export async function deleteFolderIfEmpty(account: MailAccount, path: string): Promise<boolean> {
  const leaf = path.split(/[\\/]/).pop() ?? path;
  if (PROTECTED_FOLDERS.has(leaf.trim().toLowerCase())) return false;
  return withAccount(account, async (client) => {
    const st = await client.status(path, { messages: true });
    if ((st.messages ?? 0) > 0) return false;
    await client.mailboxDelete(path);
    return true;
  });
}

interface Pooled {
  client: ImapFlow;
  lastUsed: number;
  busy: Promise<unknown>;
}

const pool = new Map<number, Pooled>();

/** 凭据变更/删除账号时，丢弃缓存连接强制重建 */
export async function evictAccount(accountId: number): Promise<void> {
  const entry = pool.get(accountId);
  pool.delete(accountId);
  if (entry) {
    try {
      await entry.client.logout();
    } catch {
      /* ignore */
    }
  }
}

/** 实际登录名：Exchange 企业邮箱填了域时用 域\用户名 */
export function loginUser(account: { domain: string | null; authUser: string }): string {
  return account.domain ? `${account.domain}\\${account.authUser}` : account.authUser;
}

/** 串行化每个账号的 IMAP 命令（ImapFlow 不支持并发命令） */
export async function withAccount<T>(account: MailAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  let entry = pool.get(account.id);
  const now = Date.now();

  if (entry && (now - entry.lastUsed > IDLE_TTL_MS || !entry.client.usable)) {
    try {
      await entry.client.logout();
    } catch {
      /* ignore */
    }
    pool.delete(account.id);
    entry = undefined;
  }

  if (!entry) {
    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      auth: { user: loginUser(account), pass: decryptSecret(account.passwordEnc) },
      logger: false,
      socketTimeout: 30_000,
      tls: { rejectUnauthorized: true },
    });
    await client.connect();
    entry = { client, lastUsed: Date.now(), busy: Promise.resolve() };
    pool.set(account.id, entry);
  }

  const run = entry.busy.then(async () => {
    // 连接可能已被其他操作的错误路径回收重建，此时不能复用旧实例
    // （imapflow 禁止对已 logout 的实例再次 connect），重新排队拿新连接
    if (pool.get(account.id) !== entry) {
      return withAccount(account, fn);
    }
    try {
      if (!entry!.client.usable) {
        await entry!.client.connect();
      }
      const result = await fn(entry!.client);
      entry!.lastUsed = Date.now();
      return result;
    } catch (err) {
      // 任何命令错误都丢弃缓存连接：服务端可能已使会话失效
      // （如重新生成授权码），复用坏连接会让所有后续请求持续失败。
      // 仅当池中仍是本实例时才移除，避免误删期间新建的连接。
      if (pool.get(account.id) === entry) pool.delete(account.id);
      try {
        await entry!.client.logout();
      } catch {
        /* ignore */
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("imap operation failed", { accountId: account.id, error: msg });
      throw err;
    }
  });
  entry.busy = run.catch(() => {});
  return run;
}

/** 每个文件夹的未读/总数（STATUS 命令，20 秒服务端缓存） */
export async function folderStatusMap(
  account: MailAccount,
): Promise<Record<string, { unseen: number; total: number }>> {
  return withAccount(account, async (client) => {
    const boxes = await client.list();
    const out: Record<string, { unseen: number; total: number }> = {};
    const failed: string[] = [];
    for (const b of boxes) {
      if (b.flags.has("\\Noselect")) continue;
      try {
        const s = await client.status(b.path, { unseen: true, messages: true });
        if (s) out[b.path] = { unseen: s.unseen ?? 0, total: s.messages ?? 0 };
      } catch {
        failed.push(b.path);
      }
    }
    // 个别文件夹（尤其 INBOX 被另一会话占用时）可能首次 STATUS 失败，稍候重试一次
    for (const path of failed) {
      try {
        await new Promise((r) => setTimeout(r, 600));
        const s = await client.status(path, { unseen: true, messages: true });
        if (s) out[b.path] = { unseen: s.unseen ?? 0, total: s.messages ?? 0 };
      } catch {
        /* 仍然失败则跳过该文件夹 */
      }
    }
    return out;
  });
}

/** 测试 IMAP 连接（不入池） */
export async function testImapConnection(input: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  domain?: string | null;
  pass: string;
}): Promise<{ ok: boolean; message?: string }> {
  const client = new ImapFlow({
    host: input.host,
    port: input.port,
    secure: input.secure,
    auth: {
      user: input.domain ? `${input.domain}\\${input.user}` : input.user,
      pass: input.pass,
    },
    logger: false,
    socketTimeout: 15_000,
  });
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function toFolderInfo(box: ListResponse): FolderInfo {
  return {
    path: box.path,
    name: box.name,
    delimiter: box.delimiter ?? "/",
    specialUse: box.specialUse ?? null,
    children: [],
  };
}

export async function listFolders(account: MailAccount): Promise<FolderInfo[]> {
  return withAccount(account, async (client) => (await client.list()).map(toFolderInfo));
}

function flagsOf(msg: { flags?: Set<string> }): string[] {
  return msg.flags ? [...msg.flags] : [];
}

/** imapflow 的 headers 在某些返回形态下是原始 Buffer，需手动解析 */
function parseRawHeaders(raw: Buffer | Uint8Array): Record<string, string> {
  const text = Buffer.from(raw).toString("utf8");
  const out: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    // 折叠头续行（以空白开头）拼到上一行
    if (/^[ \t]/.test(line) && currentKey) {
      out[currentKey] += " " + line.trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    currentKey = line.slice(0, idx).trim().toLowerCase();
    out[currentKey] = line.slice(idx + 1).trim();
  }
  return out;
}

function summarize(msg: Record<string, unknown>, folder: string): MessageSummary {
  const envelope = (msg.envelope ?? {}) as {
    subject?: string;
    from?: { address?: string; name?: string }[];
    to?: { address?: string; name?: string }[];
    cc?: { address?: string; name?: string }[];
    date?: Date;
  };
  const flags = flagsOf(msg as { flags?: Set<string> });
  const rawHeaders = msg.headers;
  const headers =
    rawHeaders instanceof Uint8Array
      ? parseRawHeaders(rawHeaders)
      : ((rawHeaders ?? {}) as Record<string, string>);
  const bodyStructure = msg.bodyStructure as { size?: number } | undefined;
  const lower = (o: object | undefined) =>
    o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), String(v)])) : {};
  return {
    uid: msg.uid as number,
    folder,
    subject: envelope.subject ?? "(无主题)",
    fromAddr: envelope.from?.[0]?.address ?? "",
    fromName: envelope.from?.[0]?.name ?? "",
    to: (envelope.to ?? []).map((a) => a.address ?? ""),
    cc: (envelope.cc ?? []).map((a) => a.address ?? ""),
    date: envelope.date ?? (msg.internalDate as Date) ?? new Date(),
    flags,
    seen: flags.includes("\\Seen"),
    starred: flags.includes("\\Flagged"),
    hasAttach: Boolean(msg.hasAttachment) || /attachment/i.test(JSON.stringify(bodyStructure ?? {})),
    sizeKb: Math.round(((bodyStructure?.size ?? 0) || 0) / 1024),
    headers: lower(headers),
    snippet: "",
  };
}

/** 拉取文件夹最近 N 封邮件（envelope + headers + flags） */
export async function fetchRecentMessages(
  account: MailAccount,
  folder: string,
  limit = 100,
): Promise<MessageSummary[]> {
  return withAccount(account, async (client) => {
    const box = await client.mailboxOpen(folder);
    const total = box.exists;
    if (total === 0) return [];
    const start = Math.max(1, total - limit + 1);
    const out: MessageSummary[] = [];
    for await (const msg of client.fetch(`${start}:*`, {
      envelope: true,
      flags: true,
      headers: true,
      bodyStructure: true,
      internalDate: true,
      size: true,
    })) {
      out.push(summarize(msg as unknown as Record<string, unknown>, folder));
    }
    return out.reverse(); // 最新在前
  });
}

/** 拉取 uid >= uidFrom 的邮件（实时新邮件推送用） */
export async function fetchMessagesByUid(
  account: MailAccount,
  folder: string,
  uidFrom: number,
): Promise<MessageSummary[]> {
  return withAccount(account, async (client) => {
    await client.mailboxOpen(folder);
    const out: MessageSummary[] = [];
    for await (const msg of client.fetch(
      `${uidFrom}:*`,
      {
        envelope: true,
        flags: true,
        headers: true,
        bodyStructure: true,
        internalDate: true,
        size: true,
      },
      { uid: true },
    )) {
      if ((msg.uid as number) < uidFrom) continue;
      out.push(summarize(msg as unknown as Record<string, unknown>, folder));
    }
    return out;
  });
}

/** 拉取单封邮件完整原文并解析 */
export async function fetchRawMessage(account: MailAccount, folder: string, uid: number): Promise<Buffer> {
  return withAccount(account, async (client) => {
    await client.mailboxOpen(folder);
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error("邮件不存在或已被移动");
    return msg.source;
  });
}

/** 抓取邮件纯文本正文（供 body 条件二次求值） */
export async function fetchBodyText(account: MailAccount, folder: string, uid: number): Promise<string> {
  const map = await fetchBodyTexts(account, folder, [uid]);
  return map.get(uid) ?? "";
}

/** 批量取正文：只开一次邮箱，供 AI 诊断等场景使用 */
export async function fetchBodyTexts(
  account: MailAccount,
  folder: string,
  uids: number[],
): Promise<Map<number, string>> {
  return withAccount(account, async (client) => {
    await client.mailboxOpen(folder);
    const out = new Map<number, string>();
    for (const uid of uids) {
      try {
        const msg = await client.fetchOne(String(uid), { bodyParts: ["text"] }, { uid: true });
        const parts = (msg as unknown as { bodyParts?: Map<string, Buffer> })?.bodyParts;
        let text = "";
        if (parts) for (const buf of parts.values()) text += buf.toString("utf8") + "\n";
        out.set(uid, text.slice(0, 200_000));
      } catch {
        out.set(uid, "");
      }
    }
    return out;
  });
}

/**
 * 确保文件夹存在。返回实际使用的路径：
 * - 部分服务器（Coremail/163）禁止建子文件夹，此时退化为扁平名（"工作/代码" → "工作-代码"）
 * - 层级创建优先逐级建父文件夹
 */
export async function ensureFolder(account: MailAccount, path: string): Promise<string> {
  // 先查列表：已存在的文件夹直接返回。
  // 163 对「创建已存在文件夹」返回的报错不含 already exists 字样，
  // 仅靠报错文本判断会把已有文件夹误判为创建失败。
  const exists = (p: string): Promise<boolean> =>
    withAccount(account, async (client) => {
      const boxes = await client.list();
      const lower = p.toLowerCase();
      return boxes.some((b) => b.path.toLowerCase() === lower);
    });

  if (await exists(path)) return path;

  const tryCreate = async (p: string): Promise<boolean> => {
    return withAccount(account, async (client) => {
      try {
        await client.mailboxCreate(p);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/already exists|ALREADYEXISTS|duplicate/i.test(msg)) return true;
        return false;
      }
    });
  };

  // 1. 直接创建完整路径
  if (await tryCreate(path)) {
    // 可能其实已存在；再验证一次层级路径确实可用（对禁子文件夹服务器，CREATE a/b 会失败所以走不到这）
    return path;
  }

  // 2. 逐级创建父文件夹后重试
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    await tryCreate(parts.slice(0, i).join("/"));
  }
  if (await tryCreate(path)) return path;

  // 3. 服务器禁止子文件夹：退化为扁平名
  const flat = path.replace(/\//g, "-");
  if (flat !== path && (await exists(flat) || (await tryCreate(flat)))) return flat;

  throw new Error(`无法创建文件夹: ${path}`);
}

export async function moveMessages(
  account: MailAccount,
  folder: string,
  uids: number[],
  dest: string,
): Promise<void> {
  return withAccount(account, async (client) => {
    await client.mailboxOpen(folder);
    const r = await client.messageMove(uids.map(String).join(","), dest, { uid: true });
    if (!r) throw new Error(`MOVE 到 ${dest} 被服务器拒绝`);
  });
}

export async function copyMessages(
  account: MailAccount,
  folder: string,
  uids: number[],
  dest: string,
): Promise<void> {
  return withAccount(account, async (client) => {
    await client.mailboxOpen(folder);
    const r = await client.messageCopy(uids.map(String).join(","), dest, { uid: true });
    if (!r) throw new Error(`COPY 到 ${dest} 被服务器拒绝`);
  });
}

export async function setFlag(
  account: MailAccount,
  folder: string,
  uids: number[],
  flag: "\\Seen" | "\\Flagged",
  on: boolean,
): Promise<void> {
  return withAccount(account, async (client) => {
    await client.mailboxOpen(folder);
    const range = uids.map(String).join(",");
    if (on) await client.messageFlagsAdd(range, [flag], { uid: true });
    else await client.messageFlagsRemove(range, [flag], { uid: true });
  });
}

/** 移到已删除/垃圾箱，或直接加 Deleted 标记 */
/** 校验目标文件夹里该 UID 是否还在且主题一致；返回可用 UID，否则 null */
export async function findMessageUid(
  account: MailAccount,
  folder: string,
  uid: number,
  subject: string,
): Promise<number | null> {
  try {
    return await withAccount(account, async (client) => {
      const box = await client.mailboxOpen(folder);
      if (!box) return null;
      // 注意：163 SELECT 不返回 UIDNEXT，不能用它做上限预检，直接按 UID 取
      const m = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
      if (!m || !("uid" in m) || m.uid !== uid) return null;
      const env = "envelope" in m ? m.envelope : undefined;
      if (env && (env.subject ?? "") !== subject) return null;
      return uid;
    });
  } catch {
    return null;
  }
}

/** 按主题在目标文件夹近期邮件里找 UID（还原的退化路径） */
export async function findBySubject(
  account: MailAccount,
  folder: string,
  subject: string,
): Promise<number | null> {
  try {
    const msgs = await fetchRecentMessages(account, folder, 50);
    const hit = msgs.find((m) => m.subject === subject);
    return hit ? hit.uid : null;
  } catch {
    return null;
  }
}

export async function deleteMessages(
  account: MailAccount,
  folder: string,
  uids: number[],
  mode: "trash" | "expunge",
): Promise<void> {
  return withAccount(account, async (client) => {
    await client.mailboxOpen(folder);
    const range = uids.map(String).join(",");
    if (mode === "trash") {
      const boxes = await client.list();
      const trash = boxes.find((b) => b.specialUse === "\\Trash");
      if (trash) {
        await client.messageMove(range, trash.path, { uid: true });
        return;
      }
    }
    await client.messageDelete(range, { uid: true });
  });
}
