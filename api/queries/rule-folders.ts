import { and, eq } from "drizzle-orm";
import * as schema from "@db/schema";
import { getDb } from "./connection";

/** 规则执行移动时登记自动创建/使用的文件夹，供删规则后级联还原删除 */
export async function recordRuleFolder(userId: number, accountId: number, folder: string) {
  await getDb()
    .insert(schema.ruleFolders)
    .values({ userId, accountId, folder })
    .onDuplicateKeyUpdate({ set: { createdAt: new Date() } });
}

export async function listRuleFolders(userId: number) {
  return getDb().select().from(schema.ruleFolders).where(eq(schema.ruleFolders.userId, userId));
}

export async function removeRuleFolder(userId: number, accountId: number, folder: string) {
  await getDb()
    .delete(schema.ruleFolders)
    .where(
      and(
        eq(schema.ruleFolders.userId, userId),
        eq(schema.ruleFolders.accountId, accountId),
        eq(schema.ruleFolders.folder, folder),
      ),
    );
}
