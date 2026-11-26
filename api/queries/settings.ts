import { eq } from "drizzle-orm";
import * as schema from "@db/schema";
import { getDb } from "./connection";

/** 读取用户全部设置（键值对） */
export async function getSettings(userId: number): Promise<Record<string, string>> {
  const rows = await getDb()
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  const out: Record<string, string> = {};
  for (const r of rows) if (r.value !== null) out[r.key] = r.value;
  return out;
}

/** 写入（覆盖）一组设置 */
export async function setSettings(userId: number, pairs: Record<string, string | undefined>) {
  const db = getDb();
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined) continue;
    await db
      .insert(schema.userSettings)
      .values({ userId, key, value })
      .onDuplicateKeyUpdate({ set: { value } });
  }
}
