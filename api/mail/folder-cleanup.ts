import { getAccountFull, listAccounts } from "../queries/accounts";
import { listRules } from "../queries/rules";
import {
  listRuleFolders,
  removeRuleFolder,
} from "../queries/rule-folders";
import {
  deleteFolderIfEmpty,
  emptyFolderBackToInbox,
  listFolders,
  type FolderInfo,
} from "./imap";

function flatten(boxes: FolderInfo[], out: FolderInfo[] = []): FolderInfo[] {
  for (const b of boxes) {
    out.push(b);
    flatten(b.children ?? [], out);
  }
  return out;
}

export interface CleanupResult {
  /** 已删除的文件夹 */
  deleted: string[];
  /** 已还原回收件箱的邮件数 */
  restored: number;
  /** 处理失败的文件夹及原因 */
  failed: { folder: string; error: string }[];
}

/**
 * 规则删除后调用：清理「规则创建过、且不再被任何规则引用」的文件夹。
 *
 * 与旧版只删空文件夹不同：先把文件夹里残留的邮件移回收件箱（还原），
 * 再删除文件夹。只动 rule_folders 里有记录的文件夹——用户自己建的
 * 文件夹（如「工作代码」「中裕康」）从未被规则记录，绝不会碰。
 * 单个文件夹失败不影响其他文件夹。
 */
export async function cleanupOrphanFolders(userId: number): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: [], restored: 0, failed: [] };
  const accounts = await listAccounts(userId);
  const rules = await listRules(userId, null);
  const records = await listRuleFolders(userId);

  // 当前仍被规则引用的移动目标（全局 + 专属都算上）
  const referenced = new Set<string>();
  for (const r of rules) {
    try {
      const actions = JSON.parse(r.actionsJson) as { type: string; folder?: string }[];
      for (const a of actions) {
        if (a.type === "move" && a.folder) referenced.add(a.folder.trim().toLowerCase());
      }
    } catch {
      /* 单条规则 JSON 异常不影响清理 */
    }
  }

  for (const rec of records) {
    if (referenced.has(rec.folder.trim().toLowerCase())) continue;
    try {
      const account = await getAccountFull(userId, rec.accountId);
      if (!account) {
        await removeRuleFolder(userId, rec.accountId, rec.folder);
        continue;
      }
      const exists = flatten(await listFolders(account)).some(
        (b) => b.path.trim().toLowerCase() === rec.folder.trim().toLowerCase(),
      );
      if (!exists) {
        await removeRuleFolder(userId, rec.accountId, rec.folder);
        continue;
      }
      result.restored += await emptyFolderBackToInbox(account, rec.folder);
      if (await deleteFolderIfEmpty(account, rec.folder)) {
        result.deleted.push(rec.folder);
      } else {
        result.failed.push({ folder: rec.folder, error: "文件夹删不掉（可能非空或服务端拒绝）" });
        continue; // 没删掉就不清记录，下次还能重试
      }
      await removeRuleFolder(userId, rec.accountId, rec.folder);
    } catch (err) {
      result.failed.push({
        folder: rec.folder,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
