import {
  mysqlTable,
  mysqlEnum,
  primaryKey,
  serial,
  varchar,
  text,
  timestamp,
  int,
  boolean,
  bigint,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  unionId: varchar("unionId", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  avatar: text("avatar"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  lastSignInAt: timestamp("lastSignInAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/** IMAP/SMTP 邮箱账号（凭据加密存储） */
export const mailAccounts = mysqlTable("mail_accounts", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  label: varchar("label", { length: 120 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  imapHost: varchar("imapHost", { length: 255 }).notNull(),
  imapPort: int("imapPort").notNull().default(993),
  imapSecure: boolean("imapSecure").notNull().default(true),
  smtpHost: varchar("smtpHost", { length: 255 }),
  smtpPort: int("smtpPort").notNull().default(465),
  smtpSecure: boolean("smtpSecure").notNull().default(true),
  authUser: varchar("authUser", { length: 320 }).notNull(),
  /** Exchange 企业邮箱的登录域（可选；填了则用 域\用户名 认证） */
  domain: varchar("domain", { length: 120 }),
  /** AES-256-GCM 密文，格式 iv:tag:ciphertext (base64) */
  passwordEnc: text("passwordEnc").notNull(),
  status: mysqlEnum("status", ["ok", "error", "syncing"]).notNull().default("ok"),
  statusMessage: text("statusMessage"),
  lastSyncAt: timestamp("lastSyncAt"),
  syncError: text("syncError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type MailAccount = typeof mailAccounts.$inferSelect;
export type InsertMailAccount = typeof mailAccounts.$inferInsert;

/** 「执行分拣」的移动日志：支持「还原上次分拣」把邮件移回原文件夹 */
export const triageJournal = mysqlTable("triage_journal", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  accountId: bigint("accountId", { mode: "number", unsigned: true }).notNull(),
  /** 一次分拣运行的标识（同一批移动共享） */
  runId: varchar("runId", { length: 40 }).notNull(),
  fromFolder: varchar("fromFolder", { length: 255 }).notNull(),
  toFolder: varchar("toFolder", { length: 255 }).notNull(),
  /** 移动后在目标文件夹中的 UID（MOVE 会改 UID，记录的是目标侧） */
  uid: int("uid").notNull(),
  subject: varchar("subject", { length: 500 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 用户级设置（键值对）：扫描范围、AI 模型配置等。aiKey 存加密密文 */
export const userSettings = mysqlTable(
  "user_settings",
  {
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    key: varchar("key", { length: 50 }).notNull(),
    value: text("value"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** 分拣规则（match/actions 为 RuleDef 的 JSON 序列化） */
export const rules = mysqlTable("rules", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  /** null = 应用于所有账号 */
  accountId: bigint("accountId", { mode: "number", unsigned: true }),
  name: varchar("name", { length: 200 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  orderIndex: int("orderIndex").notNull().default(0),
  matchJson: text("matchJson").notNull(),
  actionsJson: text("actionsJson").notNull(),
  stop: boolean("stop").notNull().default(false),
  packKey: varchar("packKey", { length: 80 }),
  /** 包来源：builtin 内置 / auto 自动创建 / ai AI诊断 / user 手动分组 */
  packOrigin: varchar("packOrigin", { length: 20 }),
  hitCount: int("hitCount").notNull().default(0),
  lastHitAt: timestamp("lastHitAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type Rule = typeof rules.$inferSelect;
export type InsertRule = typeof rules.$inferInsert;

/**
 * 规则执行时自动创建的文件夹记录。
 * 规则被删除后，对不再被任何规则引用的记录文件夹：
 * 先把里面残留的邮件移回收件箱（还原），再删除文件夹（同步删除）。
 */
export const ruleFolders = mysqlTable(
  "rule_folders",
  {
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    accountId: bigint("accountId", { mode: "number", unsigned: true }).notNull(),
    folder: varchar("folder", { length: 200 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.accountId, t.folder] })],
);

export type RuleFolder = typeof ruleFolders.$inferSelect;

/** 通讯录：自动积累发件人/收件人地址，写信时补全 */
export const contacts = mysqlTable(
  "contacts",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 200 }).notNull().default(""),
    /** 累计出现次数，用于排序 */
    usageCount: int("usageCount").notNull().default(1),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    uniqUserEmail: uniqueIndex("uniq_contacts_user_email").on(t.userId, t.email),
  }),
);

export type Contact = typeof contacts.$inferSelect;
export type InsertContact = typeof contacts.$inferInsert;

// TODO: Add your tables here. See docs/Database.md for schema examples and patterns.
//
// Example:
// export const posts = mysqlTable("posts", {
//   id: serial("id").primaryKey(),
//   title: varchar("title", { length: 255 }).notNull(),
//   content: text("content"),
//   createdAt: timestamp("created_at").notNull().defaultNow(),
// });
//
// Note: FK columns referencing a serial() PK must use:
//   bigint("columnName", { mode: "number", unsigned: true }).notNull()
