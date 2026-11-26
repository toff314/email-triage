import { and, desc, eq, lt } from "drizzle-orm";
import * as schema from "@db/schema";
import { getDb } from "./connection";

export interface MoveEntry {
  fromFolder: string;
  toFolder: string;
  uid: number;
  subject: string;
}

/** 记录一次分拣运行的移动日志 */
export async function insertJournal(
  userId: number,
  accountId: number,
  runId: string,
  moves: MoveEntry[],
) {
  if (moves.length === 0) return;
  const db = getDb();
  for (const m of moves) {
    await db.insert(schema.triageJournal).values({ userId, accountId, runId, ...m });
  }
  // 只保留最近 7 天的日志，避免无限增长
  await db
    .delete(schema.triageJournal)
    .where(lt(schema.triageJournal.createdAt, new Date(Date.now() - 7 * 24 * 3600 * 1000)));
}

/** 最近一次有日志的分拣运行 */
export async function latestJournalRun(accountId: number) {
  const row = await getDb()
    .select({ runId: schema.triageJournal.runId })
    .from(schema.triageJournal)
    .where(eq(schema.triageJournal.accountId, accountId))
    .orderBy(desc(schema.triageJournal.id))
    .limit(1);
  return row.at(0)?.runId ?? null;
}

export async function journalRunRows(accountId: number, runId: string): Promise<MoveEntry[]> {
  const rows = await getDb()
    .select()
    .from(schema.triageJournal)
    .where(
      and(eq(schema.triageJournal.accountId, accountId), eq(schema.triageJournal.runId, runId)),
    )
    .orderBy(desc(schema.triageJournal.id));
  return rows.map((r) => ({
    fromFolder: r.fromFolder,
    toFolder: r.toFolder,
    uid: r.uid,
    subject: r.subject,
  }));
}

/** 消费掉已还原的运行日志 */
export async function deleteJournalRun(accountId: number, runId: string) {
  await getDb()
    .delete(schema.triageJournal)
    .where(and(eq(schema.triageJournal.accountId, accountId), eq(schema.triageJournal.runId, runId)));
}
