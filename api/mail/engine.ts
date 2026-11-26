import {
  evalGroup,
  matchRules,
  type EvalMessage,
  type RuleAction,
  type RuleDef,
} from "@contracts/rules";
import type { MailAccount, Rule } from "@db/schema";
import { bumpRuleHits } from "../queries/rules";
import { recordRuleFolder } from "../queries/rule-folders";
import { log } from "../lib/logger";
import {
  deleteMessages,
  ensureFolder,
  fetchBodyText,
  fetchRecentMessages,
  moveMessages,
  setFlag,
  type MessageSummary,
} from "./imap";

export function rowToRuleDef(row: Rule): RuleDef {
  return {
    id: String(row.id),
    name: row.name,
    enabled: row.enabled,
    priority: 0,
    match: JSON.parse(row.matchJson),
    actions: JSON.parse(row.actionsJson),
    stop: row.stop,
    packKey: row.packKey ?? undefined,
  };
}

export function toEvalMessage(m: MessageSummary): EvalMessage {
  return {
    fromAddr: m.fromAddr,
    fromName: m.fromName,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    bodyText: m.snippet,
    headers: m.headers,
    listId: m.headers["list-id"],
    sizeKb: m.sizeKb,
    ageDays: (Date.now() - m.date.getTime()) / 86_400_000,
    hasAttach: m.hasAttach,
    folder: m.folder,
    accountId: m.folder,
    read: m.seen,
    starred: m.starred,
  };
}

/** 规则组是否包含 body 条件（需要二次抓正文） */
function groupHasBody(g: RuleDef["match"]): boolean {
  if (g.conditions.some((c) => c.field === "body")) return true;
  return (g.groups ?? []).some(groupHasBody);
}

/** 忽略 body 条件求值（其余条件满足才值得抓正文） */
function evalGroupIgnoringBody(g: RuleDef["match"], msg: EvalMessage): boolean {
  const strip = (x: RuleDef["match"]): RuleDef["match"] => ({
    op: x.op,
    conditions: x.conditions.filter((c) => c.field !== "body"),
    groups: (x.groups ?? []).map(strip),
  });
  return evalGroup(strip(g), msg);
}

export interface RunResult {
  scanned: number;
  matched: number;
  moved: number;
  flagged: number;
  deleted: number;
  errors: string[];
  perRule: { ruleId: string; name: string; hits: number }[];
  /** 本次移动的明细（还原上次分拣用）：uid 为移动后在目标文件夹的 UID */
  moves: { fromFolder: string; toFolder: string; uid: number; subject: string }[];
}

/**
 * MOVE 之后旧 UID 失效。按主题在目标文件夹近期邮件里配对新 UID；
 * 配不上（并发进信等）记 uid=-1，还原时退化为按主题查找。
 */
async function resolveMovedUids(
  account: MailAccount,
  fromFolder: string,
  toFolder: string,
  uids: number[],
  messages: MessageSummary[],
): Promise<RunResult["moves"]> {
  const byUid = new Map(messages.map((m) => [m.uid, m]));
  const out: RunResult["moves"] = [];
  let destMsgs: MessageSummary[] = [];
  try {
    destMsgs = await fetchRecentMessages(account, toFolder, uids.length + 10);
  } catch {
    /* 读不到目标就按主题退化 */
  }
  const bySubject = new Map<string, number[]>();
  for (const dm of destMsgs) {
    const arr = bySubject.get(dm.subject) ?? [];
    arr.push(dm.uid);
    bySubject.set(dm.subject, arr);
  }
  for (const uid of uids) {
    const m = byUid.get(uid);
    if (!m) continue;
    const candidates = bySubject.get(m.subject);
    const newUid = candidates && candidates.length > 0 ? (candidates.shift() as number) : -1;
    out.push({ fromFolder, toFolder, uid: newUid, subject: m.subject });
  }
  return out;
}

export interface PlanEntry {
  msg: MessageSummary;
  actions: RuleAction[];
  /** 命中规则 id（字符串形式，用于命中计数） */
  hitRuleIds: string[];
  /** 命中规则名（预览展示用） */
  hitRuleNames: string[];
}

/**
 * 纯求值：对一批邮件计算规则命中与动作计划。
 * 零副作用（不写库、不动 IMAP），dry-run 预览和执行路径共用。
 */
export async function planForMessages(
  account: MailAccount,
  rows: Rule[],
  messages: MessageSummary[],
): Promise<{ plans: PlanEntry[]; errors: string[] }> {
  const plans: PlanEntry[] = [];
  const errors: string[] = [];
  const ruleDefs = rows.map(rowToRuleDef);
  const bodyRules = ruleDefs.filter((r) => groupHasBody(r.match));

  for (const m of messages) {
    try {
      let evalMsg = { ...toEvalMessage(m), accountId: String(account.id) };
      if (bodyRules.length > 0) {
        const maybe = bodyRules.filter((r) => evalGroupIgnoringBody(r.match, evalMsg));
        if (maybe.length > 0) {
          const bodyText = await fetchBodyText(account, m.folder, m.uid);
          evalMsg = { ...evalMsg, bodyText };
        }
      }
      const hits = matchRules(ruleDefs, evalMsg);
      if (hits.length === 0) continue;
      const actions: RuleAction[] = [];
      for (const h of hits) actions.push(...h.actions);
      plans.push({
        msg: m,
        actions,
        hitRuleIds: hits.map((h) => h.rule.id ?? ""),
        hitRuleNames: hits.map((h) => h.rule.name ?? ""),
      });
    } catch (err) {
      log.warn("rule evaluation failed", { uid: m.uid, error: String(err) });
      errors.push(`uid=${m.uid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { plans, errors };
}

/**
 * 对某文件夹的一批消息执行规则。
 * 执行策略：先逐封求值（body 条件两趟），再按动作类型分批下发 IMAP 命令，
 * 避免逐封移动造成的几十次往返（防止代理超时）。
 */
export async function runRulesOnMessages(
  account: MailAccount,
  rows: Rule[],
  messages: MessageSummary[],
): Promise<RunResult> {
  const result: RunResult = {
    scanned: messages.length,
    matched: 0,
    moved: 0,
    flagged: 0,
    deleted: 0,
    errors: [],
    perRule: [],
    moves: [],
  };
  if (rows.length === 0 || messages.length === 0) return result;

  const { plans, errors } = await planForMessages(account, rows, messages);
  result.errors.push(...errors);
  result.matched = plans.length;
  const idByName = new Map(rows.map((r) => [String(r.id), r.id]));
  const nameById = new Map(rows.map((r) => [String(r.id), r.name]));
  const hitCounts = new Map<number, number>();
  for (const p of plans) {
    for (const rid of p.hitRuleIds) {
      const numId = idByName.get(rid);
      if (numId !== undefined) hitCounts.set(numId, (hitCounts.get(numId) ?? 0) + 1);
    }
  }
  for (const [numId, n] of hitCounts) {
    await bumpRuleHits(numId, n);
    result.perRule.push({ ruleId: String(numId), name: nameById.get(String(numId)) ?? "", hits: n });
  }

  // ---- 第二遍：批量执行。移动按目标文件夹分组，每封邮件只移动一次 ----
  const moveGroups = new Map<string, number[]>(); // dest -> uids
  const trashUids: number[] = [];
  const readUids: number[] = [];
  const unreadUids: number[] = [];
  const starUids: number[] = [];
  const unstarUids: number[] = [];

  for (const p of plans) {
    const m = p.msg;
    let moved = false;
    for (const a of p.actions) {
      switch (a.type) {
        case "move":
        case "archive": {
          if (moved) break;
          const dest = a.type === "archive" ? "Archive" : (a.folder ?? "Archive");
          moveGroups.set(dest, [...(moveGroups.get(dest) ?? []), m.uid]);
          moved = true;
          break;
        }
        case "spam": {
          if (moved) break;
          moveGroups.set("\\Spam", [...(moveGroups.get("\\Spam") ?? []), m.uid]);
          moved = true;
          break;
        }
        case "delete":
          trashUids.push(m.uid);
          break;
        case "mark_read":
          readUids.push(m.uid);
          break;
        case "mark_unread":
          unreadUids.push(m.uid);
          break;
        case "star":
        case "set_flag":
          starUids.push(m.uid);
          break;
        case "unstar":
          unstarUids.push(m.uid);
          break;
        default:
          break; // notify / assign_category：应用内语义
      }
    }
  }

  // 标记必须先于移动执行：IMAP MOVE 会改变 UID，
  // 先移动再打标会因 UID 失效而静默失败（如「移动+加星」的星标丢失）
  const flagOps: [number[], "\\Seen" | "\\Flagged", boolean][] = [
    [readUids, "\\Seen", true],
    [unreadUids, "\\Seen", false],
    [starUids, "\\Flagged", true],
    [unstarUids, "\\Flagged", false],
  ];
  for (const [uids, flag, on] of flagOps) {
    if (uids.length === 0) continue;
    try {
      await setFlag(account, messages[0].folder, uids, flag, on);
      result.flagged += uids.length;
    } catch (err) {
      result.errors.push(`标记失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 移动（垃圾邮件目标特殊处理：先试 Junk 再试 Spam）
  for (const [dest, uids] of moveGroups) {
    try {
      let actual: string;
      if (dest === "\\Spam") {
        try {
          await moveMessages(account, messages[0].folder, uids, "Junk");
          actual = "Junk";
        } catch {
          await moveMessages(account, messages[0].folder, uids, "Spam");
          actual = "Spam";
        }
      } else {
        // 确保目标存在；服务器禁止子文件夹时用降级后的实际路径
        actual = await ensureFolder(account, dest);
        await moveMessages(account, messages[0].folder, uids, actual);
        // 登记：这是规则创建/使用的文件夹，删规则后据此级联还原删除
        void recordRuleFolder(account.userId, account.id, actual).catch(() => {});
      }
      result.moved += uids.length;
      // 记录移动明细供「还原」：MOVE 会改 UID，移动后按主题配对新 UID
      result.moves.push(
        ...await resolveMovedUids(account, messages[0].folder, actual, uids, messages),
      );
    } catch (err) {
      result.errors.push(
        `移动 ${uids.length} 封到 ${dest} 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 删除（进垃圾箱，最后执行）
  if (trashUids.length > 0) {
    try {
      await deleteMessages(account, messages[0].folder, trashUids, "trash");
      result.deleted += trashUids.length;
    } catch (err) {
      result.errors.push(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
