import { contacts } from "@db/schema";
import { getDb } from "./connection";
import { eq, desc, sql } from "drizzle-orm";

/**
 * 累积联系人：同一地址多次出现时只计数一次/批，次数用于排序。
 * 用原生 INSERT ... ON DUPLICATE KEY UPDATE 避免并发先查后插的竞态。
 */
export async function upsertContacts(
  userId: number,
  addrs: { email?: string | null; name?: string | null }[],
): Promise<void> {
  const clean = new Map<string, string>();
  for (const a of addrs) {
    const email = (a.email ?? "").trim().toLowerCase();
    if (!email.includes("@") || email.length > 320) continue;
    const name = (a.name ?? "").trim().slice(0, 200);
    if (!clean.has(email)) clean.set(email, name);
  }
  if (clean.size === 0) return;
  const db = getDb();
  for (const [email, name] of clean) {
    await db.execute(sql`
      INSERT INTO contacts (userId, email, name, usageCount, lastSeenAt)
      VALUES (${userId}, ${email}, ${name}, 1, NOW())
      ON DUPLICATE KEY UPDATE
        usageCount = usageCount + 1,
        lastSeenAt = NOW(),
        name = CASE WHEN name = '' AND ${name} != '' THEN ${name} ELSE name END
    `);
  }
}

export async function listContacts(userId: number) {
  return getDb()
    .select()
    .from(contacts)
    .where(eq(contacts.userId, userId))
    .orderBy(desc(contacts.usageCount), desc(contacts.lastSeenAt));
}
