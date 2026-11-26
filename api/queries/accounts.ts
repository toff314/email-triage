import { asc, eq } from "drizzle-orm";
import * as schema from "@db/schema";
import type { InsertMailAccount } from "@db/schema";
import { getDb } from "./connection";
import { encryptSecret } from "../lib/crypto";

export async function listAccounts(userId: number) {
  const rows = await getDb()
    .select({
      id: schema.mailAccounts.id,
      label: schema.mailAccounts.label,
      email: schema.mailAccounts.email,
      imapHost: schema.mailAccounts.imapHost,
      imapPort: schema.mailAccounts.imapPort,
      imapSecure: schema.mailAccounts.imapSecure,
      smtpHost: schema.mailAccounts.smtpHost,
      smtpPort: schema.mailAccounts.smtpPort,
      smtpSecure: schema.mailAccounts.smtpSecure,
      authUser: schema.mailAccounts.authUser,
      domain: schema.mailAccounts.domain,
      status: schema.mailAccounts.status,
      statusMessage: schema.mailAccounts.statusMessage,
      lastSyncAt: schema.mailAccounts.lastSyncAt,
      createdAt: schema.mailAccounts.createdAt,
    })
    .from(schema.mailAccounts)
    .where(eq(schema.mailAccounts.userId, userId))
    .orderBy(asc(schema.mailAccounts.id));
  return rows;
}

/** 供 IMAP 层使用：包含加密凭据的完整行 */
export async function getAccountFull(userId: number, accountId: number) {
  const rows = await getDb()
    .select()
    .from(schema.mailAccounts)
    .where(eq(schema.mailAccounts.id, accountId))
    .limit(1);
  const row = rows.at(0);
  if (!row || row.userId !== userId) return null;
  return row;
}

export async function createAccount(
  userId: number,
  input: Omit<InsertMailAccount, "id" | "userId" | "passwordEnc"> & { password: string },
) {
  const { password, ...rest } = input;
  await getDb().insert(schema.mailAccounts).values({
    ...rest,
    userId,
    passwordEnc: encryptSecret(password),
  });
}

export async function updateAccount(
  _userId: number,
  accountId: number,
  input: Partial<Omit<InsertMailAccount, "id" | "userId" | "passwordEnc">> & { password?: string },
) {
  const { password, ...rest } = input;
  const values: Partial<InsertMailAccount> = { ...rest };
  if (password) values.passwordEnc = encryptSecret(password);
  await getDb()
    .update(schema.mailAccounts)
    .set(values)
    .where(eq(schema.mailAccounts.id, accountId));
}

export async function deleteAccount(_userId: number, accountId: number) {
  const db = getDb();
  await db.delete(schema.mailAccounts).where(eq(schema.mailAccounts.id, accountId));
  // 级联清掉该账号的本地数据：分拣日志、规则目录记录、只作用于该账号的规则。
  // （联系人是用户级共享数据，保留；accountId 为 null 的规则应用于所有账号，保留）
  await db.delete(schema.triageJournal).where(eq(schema.triageJournal.accountId, accountId));
  await db.delete(schema.ruleFolders).where(eq(schema.ruleFolders.accountId, accountId));
  await db.delete(schema.rules).where(eq(schema.rules.accountId, accountId));
}

export async function setAccountStatus(
  accountId: number,
  status: "ok" | "error" | "syncing",
  message?: string | null,
) {
  await getDb()
    .update(schema.mailAccounts)
    .set({ status, statusMessage: message ?? null, ...(status === "ok" ? { syncError: null } : {}) })
    .where(eq(schema.mailAccounts.id, accountId));
}
