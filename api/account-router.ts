import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import {
  createAccount,
  deleteAccount,
  getAccountFull,
  listAccounts,
  updateAccount,
} from "./queries/accounts";
import { testImapConnection, evictAccount, listFolders, emptyFolderBackToInbox, deleteFolderIfEmpty, PROTECTED_FOLDERS } from "./mail/imap";
import { stopWatcher } from "./mail/watcher";
import { decryptSecret } from "./lib/crypto";

const accountInput = z.object({
  label: z.string().min(1).max(120),
  email: z.string().email().max(320),
  imapHost: z.string().min(1).max(255),
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapSecure: z.boolean().default(true),
  smtpHost: z.string().max(255).optional(),
  smtpPort: z.number().int().min(1).max(65535).default(465),
  smtpSecure: z.boolean().default(true),
  authUser: z.string().min(1).max(320),
  /** Exchange 企业邮箱登录域（可选，填了用 域\用户名 认证） */
  domain: z.string().max(120).optional(),
  password: z.string().min(1),
});

export const accountRouter = createRouter({
  list: authedQuery.query(async ({ ctx }) => listAccounts(ctx.user.id)),

  create: authedQuery
    .input(accountInput)
    .mutation(async ({ ctx, input }) => {
      await createAccount(ctx.user.id, input);
      return { ok: true };
    }),

  update: authedQuery
    .input(accountInput.partial().extend({ id: z.number().int(), password: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...rest } = input;
      await updateAccount(ctx.user.id, id, rest);
      // 凭据/主机变更后，旧连接与监控必须作废
      await evictAccount(id);
      await stopWatcher(id);
      return { ok: true };
    }),

  /**
   * 删除账号：本地数据级联清（mail_accounts、triage_journal、rule_folders、专属规则）。
   * cleanupFolders（默认 true）时，先清理服务器上该账号的自建文件夹：
   * 里面的邮件移回收件箱、再删目录；系统/服务商内置目录永不触碰。
   */
  remove: authedQuery
    .input(z.object({ id: z.number().int(), cleanupFolders: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const cleanup = input.cleanupFolders ?? true;
      const account = await getAccountFull(ctx.user.id, input.id);
      let restored = 0;
      let removedFolders: string[] = [];
      let failedFolders: string[] = [];
      if (cleanup && account) {
        const folders = await listFolders(account);
        for (const f of folders) {
          const leaf = (f.path.split(/[\\/]/).pop() ?? f.path).trim().toLowerCase();
          if (PROTECTED_FOLDERS.has(leaf)) continue;
          try {
            restored += await emptyFolderBackToInbox(account, f.path);
            if (await deleteFolderIfEmpty(account, f.path)) removedFolders.push(f.path);
            else failedFolders.push(f.path);
          } catch {
            failedFolders.push(f.path);
          }
        }
      }
      await deleteAccount(ctx.user.id, input.id);
      await evictAccount(input.id);
      await stopWatcher(input.id);
      return { restored, removedFolders, failedFolders };
    }),

  /** 用已保存的凭据测试 IMAP 连接 */
  test: authedQuery
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const account = await getAccountFull(ctx.user.id, input.id);
      if (!account) return { ok: false, message: "账号不存在" };
      return testImapConnection({
        host: account.imapHost,
        port: account.imapPort,
        secure: account.imapSecure,
        user: account.authUser,
        domain: account.domain,
        pass: decryptSecret(account.passwordEnc),
      });
    }),

  /**
   * 用表单当前填写的内容测试 IMAP 连接（不落库）。
   * 密码留空时回退到已保存的凭据（仅编辑已有账号时）；新账号必须填密码。
   */
  testDraft: authedQuery
    .input(
      z.object({
        id: z.number().int().optional(),
        imapHost: z.string().min(1).max(255),
        imapPort: z.number().int().min(1).max(65535),
        imapSecure: z.boolean(),
        authUser: z.string().min(1).max(320),
        domain: z.string().max(120).optional(),
        password: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let pass = input.password;
      if (!pass) {
        if (!input.id) return { ok: false, message: "请先填写密码/授权码" };
        const account = await getAccountFull(ctx.user.id, input.id);
        if (!account) return { ok: false, message: "账号不存在" };
        pass = decryptSecret(account.passwordEnc);
      }
      return testImapConnection({
        host: input.imapHost,
        port: input.imapPort,
        secure: input.imapSecure,
        user: input.authUser,
        domain: input.domain,
        pass,
      });
    }),
});
