import { and, asc, eq, sql } from "drizzle-orm";
import * as schema from "@db/schema";
import type { InsertRule } from "@db/schema";
import { getDb } from "./connection";

export async function listRules(userId: number, accountId?: number | null) {
  const cond = accountId
    ? and(eq(schema.rules.userId, userId), eq(schema.rules.accountId, accountId))
    : eq(schema.rules.userId, userId);
  return getDb().select().from(schema.rules).where(cond).orderBy(asc(schema.rules.orderIndex));
}

/** 某账号生效的规则：账号专属 + 全局（accountId 为 null），按 orderIndex */
export async function listRulesForAccount(userId: number, accountId: number) {
  const rows = await getDb()
    .select()
    .from(schema.rules)
    .where(
      and(
        eq(schema.rules.userId, userId),
        // accountId 匹配或为 null（全局规则）
      ),
    )
    .orderBy(asc(schema.rules.orderIndex));
  return rows.filter((r) => r.accountId === null || r.accountId === accountId);
}

export async function createRule(userId: number, input: Omit<InsertRule, "id" | "userId">) {
  await getDb().insert(schema.rules).values({ ...input, userId });
}

export async function updateRule(userId: number, ruleId: number, input: Partial<InsertRule>) {
  await getDb()
    .update(schema.rules)
    .set(input)
    .where(and(eq(schema.rules.id, ruleId), eq(schema.rules.userId, userId)));
}

export async function deleteRule(userId: number, ruleId: number) {
  await getDb()
    .delete(schema.rules)
    .where(and(eq(schema.rules.id, ruleId), eq(schema.rules.userId, userId)));
}

/** 整体重排 orderIndex */
export async function reorderRules(userId: number, ids: number[]) {
  const db = getDb();
  for (let i = 0; i < ids.length; i++) {
    await db
      .update(schema.rules)
      .set({ orderIndex: i })
      .where(and(eq(schema.rules.id, ids[i]), eq(schema.rules.userId, userId)));
  }
}

export async function bumpRuleHits(ruleId: number, increment = 1) {
  await getDb()
    .update(schema.rules)
    .set({ hitCount: sql`hitCount + ${increment}`, lastHitAt: new Date() })
    .where(eq(schema.rules.id, ruleId));
}
