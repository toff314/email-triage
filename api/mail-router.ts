import { z } from "zod";
import { randomUUID } from "node:crypto";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { createRouter, authedQuery } from "./middleware";
import { getAccountFull, setAccountStatus } from "./queries/accounts";
import { listRulesForAccount, updateRule } from "./queries/rules";
import {
  copyMessages,
  deleteMessages,
  emptyFolderBackToInbox,
  deleteFolderIfEmpty,
  ensureFolder,
  fetchMessagesByUid,
  fetchRawMessage,
  fetchRecentMessages,
  findBySubject,
  findMessageUid,
  folderStatusMap,
  listFolders,
  moveMessages,
  PROTECTED_FOLDERS,
  setFlag,
  withAccount,
} from "./mail/imap";
import { stopWatcher } from "./mail/watcher";
import { listRuleFolders, recordRuleFolder, removeRuleFolder } from "./queries/rule-folders";
import {
  deleteJournalRun,
  insertJournal,
  journalRunRows,
  latestJournalRun,
} from "./queries/triage-journal";
import { planForMessages, runRulesOnMessages } from "./mail/engine";
import { sendMail } from "./mail/smtp";
import { upsertContacts } from "./queries/contacts";
import { boolSettingOf, numSettingOf } from "./settings-router";

/** 未读数 20 秒服务端缓存，避免每次打开都刷一轮 STATUS */
const statusCache = new Map<number, { at: number; data: Record<string, { unseen: number; total: number }> }>();
const STATUS_TTL = 20_000;
const starredCache = new Map<number, { at: number; data: Awaited<ReturnType<typeof fetchRecentMessages>> }>();

const accountIdInput = z.object({ accountId: z.number().int() });

function requireAccount(ctx: { user: { id: number } }, accountId: number) {
  return getAccountFull(ctx.user.id, accountId);
}

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "table", "thead", "tbody", "tr", "td", "th", "hr", "span", "center"]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ["src", "alt", "width", "height"],
    "*": ["href", "src"],
  },
  disallowedTagsMode: "discard",
  // 阻断外链图片追踪等主动内容
  transformTags: {
    img: sanitizeHtml.simpleTransform("img", { loading: "lazy" }),
  },
};

function addrs(o: unknown): { name: string; address: string }[] {
  const v = (o as { value?: { name?: string; address?: string }[] } | undefined)?.value;
  return (v ?? []).map((a) => ({ name: a.name ?? "", address: a.address ?? "" }));
}

export const mailRouter = createRouter({
  folders: authedQuery.input(accountIdInput).query(async ({ ctx, input }) => {
    const account = await requireAccount(ctx, input.accountId);
    if (!account) throw new Error("账号不存在");
    return listFolders(account);
  }),

  /** 新建文件夹（手动管理，与规则无关） */
  folderCreate: authedQuery
    .input(z.object({ accountId: z.number().int(), name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      if (PROTECTED_FOLDERS.has(input.name.toLowerCase())) throw new Error("该文件夹受保护，不能创建同名文件夹");
      const actual = await ensureFolder(account, input.name);
      return { name: actual };
    }),

  /**
   * 重命名文件夹：服务器端 RENAME 后，同步更新引用它的规则的移动目标
   * （规则里存的是逻辑名「通知/阿里云」，物理目录被 163 压平成「通知-阿里云」，
   * 按压平名匹配）。返回实际新名和改动的规则数。
   */
  folderRename: authedQuery
    .input(
      z.object({
        accountId: z.number().int(),
        from: z.string().min(1).max(200),
        to: z.string().trim().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const leaf = input.from.split(/[\\/]/).pop() ?? input.from;
      if (PROTECTED_FOLDERS.has(leaf.trim().toLowerCase())) throw new Error("系统文件夹不能重命名");
      if (PROTECTED_FOLDERS.has(input.to.toLowerCase())) throw new Error("不能改成系统文件夹的名字");
      await withAccount(account, async (client) => {
        await client.mailboxRename(input.from, input.to);
      });
      // 同步规则里的移动目标（匹配压平后的物理名）
      let updatedRules = 0;
      const flatFrom = input.from.replace(/\//g, "-");
      const rows = await listRulesForAccount(ctx.user.id, input.accountId);
      for (const r of rows) {
        const actions = JSON.parse(r.actionsJson) as { type: string; folder?: string }[];
        let changed = false;
        for (const a of actions) {
          if (a.type === "move" && a.folder && a.folder.replace(/\//g, "-") === flatFrom) {
            a.folder = input.to;
            changed = true;
          }
        }
        if (changed) {
          await updateRule(ctx.user.id, r.id, { actionsJson: JSON.stringify(actions) });
          updatedRules++;
        }
      }
      // rule_folders 记录跟着改名
      const recs = await listRuleFolders(ctx.user.id);
      if (recs.some((x) => x.accountId === input.accountId && x.folder === input.from)) {
        await removeRuleFolder(ctx.user.id, input.accountId, input.from);
        await recordRuleFolder(ctx.user.id, input.accountId, input.to);
      }
      return { name: input.to, updatedRules };
    }),

  /**
   * 删除文件夹：把里面残留的邮件先移回收件箱，再删空目录；
   * 返回移回的封数、是否删除成功、以及仍然引用该目录的规则名（由前端提示用户处理）。
   */
  folderRemove: authedQuery
    .input(z.object({ accountId: z.number().int(), name: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const leaf = input.name.split(/[\\/]/).pop() ?? input.name;
      if (PROTECTED_FOLDERS.has(leaf.trim().toLowerCase())) throw new Error("系统文件夹不能删除");
      const moved = await emptyFolderBackToInbox(account, input.name);
      const deleted = await deleteFolderIfEmpty(account, input.name);
      await removeRuleFolder(ctx.user.id, input.accountId, input.name).catch(() => {});
      const flatName = input.name.replace(/\//g, "-");
      const rows = await listRulesForAccount(ctx.user.id, input.accountId);
      const referencedRules = rows
        .filter((r) => {
          const actions = JSON.parse(r.actionsJson) as { type: string; folder?: string }[];
          return actions.some((a) => a.type === "move" && a.folder && a.folder.replace(/\//g, "-") === flatName);
        })
        .map((r) => r.name);
      return { moved, deleted, referencedRules };
    }),

  /** 各文件夹未读/总数 */
  folderStatus: authedQuery.input(accountIdInput).query(async ({ ctx, input }) => {
    const account = await requireAccount(ctx, input.accountId);
    if (!account) throw new Error("账号不存在");
    const cached = statusCache.get(input.accountId);
    if (cached && Date.now() - cached.at < STATUS_TTL) return cached.data;
    const data = await folderStatusMap(account);
    statusCache.set(input.accountId, { at: Date.now(), data });
    return data;
  }),

  list: authedQuery
    .input(
      z.object({
        accountId: z.number().int(),
        folder: z.string().default("INBOX"),
        /** 不传则用设置页的「列表每页封数」 */
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const limit = input.limit ?? (await numSettingOf(ctx.user.id, "listLimit"));
      const messages = await fetchRecentMessages(account, input.folder, limit);
      // 异步累积通讯录（默认关闭，见设置「自动记录联系人」），不阻塞列表加载
      if (await boolSettingOf(ctx.user.id, "collectContacts")) {
        void upsertContacts(
          ctx.user.id,
          messages.flatMap((m) => [
            { email: m.fromAddr, name: m.fromName },
            ...m.to.map((email) => ({ email })),
          ]),
        ).catch(() => {});
      }
      return messages;
    }),

  /** 查看单封邮件（HTML 消毒 + 纯文本兜底） */
  message: authedQuery
    .input(z.object({ accountId: z.number().int(), folder: z.string(), uid: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const raw = await fetchRawMessage(account, input.folder, input.uid);
      const parsed = await simpleParser(raw);
      const html = parsed.html ? sanitizeHtml(parsed.html, SANITIZE_OPTS) : null;
      if (await boolSettingOf(ctx.user.id, "collectContacts")) {
        void upsertContacts(ctx.user.id, [
          ...addrs(parsed.from),
          ...addrs(parsed.to),
          ...addrs(parsed.cc),
        ]).catch(() => {});
      }
      return {
        subject: parsed.subject ?? "(无主题)",
        from: addrs(parsed.from),
        to: addrs(parsed.to),
        cc: addrs(parsed.cc),
        date: parsed.date ?? new Date(),
        html,
        text: parsed.text ?? "",
        attachments: parsed.attachments.map((a) => ({
          filename: a.filename ?? "附件",
          size: a.size,
          contentType: a.contentType,
        })),
      };
    }),

  /**
   * 分拣预览（dry-run）：只评估、不执行。
   * 返回每封命中邮件的去向、动作和命中规则，供用户在页面上确认后再执行。
   */
  previewRun: authedQuery
    .input(
      z.object({
        accountId: z.number().int(),
        folder: z.string().default("INBOX"),
        limit: z.number().int().min(1).max(300).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const rows = await listRulesForAccount(ctx.user.id, input.accountId);
      if (rows.length === 0) throw new Error("该账号还没有启用任何规则");
      const messages = await fetchRecentMessages(
        account,
        input.folder,
        input.limit ?? (await numSettingOf(ctx.user.id, "runLimit")),
      );
      const { plans, errors } = await planForMessages(account, rows, messages);
      const hitUids = new Set(plans.map((p) => p.msg.uid));
      const items = plans.map((p) => {
        const move = p.actions.find(
          (a) => a.type === "move" || a.type === "archive" || a.type === "spam",
        );
        const dest =
          move === undefined
            ? null
            : move.type === "spam"
              ? "垃圾邮件"
              : move.type === "archive"
                ? "存档"
                : (move.folder ?? "存档");
        const flags = p.actions
          .filter((a) => ["mark_read", "mark_unread", "star", "unstar", "delete"].includes(a.type))
          .map((a) => a.type);
        return {
          uid: p.msg.uid,
          subject: p.msg.subject,
          from: p.msg.fromAddr,
          date: p.msg.date,
          dest,
          flags,
          rules: p.hitRuleNames,
        };
      });
      const unmatched = messages
        .filter((m) => !hitUids.has(m.uid))
        .map((m) => ({ uid: m.uid, subject: m.subject, from: m.fromAddr }));
      return { scanned: messages.length, matched: plans.length, items, unmatched, errors };
    }),

  /** 手动触发：对某文件夹执行分拣规则 */
  runRules: authedQuery
    .input(
      z.object({
        accountId: z.number().int(),
        folder: z.string().default("INBOX"),
        limit: z.number().int().min(1).max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const rows = await listRulesForAccount(ctx.user.id, input.accountId);
      if (rows.length === 0) throw new Error("该账号还没有启用任何规则");
      await setAccountStatus(input.accountId, "syncing");
      try {
        const messages = await fetchRecentMessages(
          account,
          input.folder,
          input.limit ?? (await numSettingOf(ctx.user.id, "runLimit")),
        );
        const result = await runRulesOnMessages(account, rows, messages);
        await setAccountStatus(input.accountId, result.errors.length > 0 ? "error" : "ok", result.errors[0] ?? null);
        // 移动明细落日志，供「还原上次分拣」使用
        if (result.moves.length > 0) {
          await insertJournal(ctx.user.id, input.accountId, randomUUID(), result.moves);
        }
        return result;
      } catch (err) {
        await setAccountStatus(input.accountId, "error", err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        statusCache.delete(input.accountId);
      }
    }),

  /** 还原上次手动「执行分拣」的移动；实时监控的分拣不在还原范围内 */
  restoreLastRun: authedQuery
    .input(z.object({ accountId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const runId = await latestJournalRun(input.accountId);
      if (!runId) throw new Error("没有可还原的分拣记录（只记录手动「执行分拣」，且日志保留 7 天）");
      const rows = await journalRunRows(input.accountId, runId);
      if (rows.length === 0) throw new Error("该记录已失效");

      // 暂停实时监控：还原期间新邮件事件不应触发自动分拣，避免刚移回又被移走。
      // SSE 前端会自动重连，watcher 随后按新水位重启。
      await stopWatcher(input.accountId);

      let restored = 0;
      let skipped = 0;
      try {
        for (const r of rows) {
          try {
            let uid = r.uid;
            if (uid > 0) {
              // 校验 UID 还在且主题一致；已被再次移动/删除则跳过
              const still = await findMessageUid(account, r.toFolder, uid, r.subject);
              if (still === null) {
                skipped++;
                continue;
              }
              uid = still;
            } else {
              // 当初没配对新 UID：按主题在目标文件夹近期邮件里找
              const found = await findBySubject(account, r.toFolder, r.subject);
              if (found === null) {
                skipped++;
                continue;
              }
              uid = found;
            }
            await moveMessages(account, r.toFolder, [uid], r.fromFolder);
            restored++;
          } catch {
            skipped++;
          }
        }
      } finally {
        statusCache.delete(input.accountId);
      }
      // 无论成败都消费掉本次日志，避免半还原状态被重复执行
      await deleteJournalRun(input.accountId, runId);
      return { restored, skipped };
    }),

  /** 快速分拣动作（UI 单封/多封操作） */
  triage: authedQuery
    .input(
      z.object({
        accountId: z.number().int(),
        folder: z.string(),
        uids: z.array(z.number().int()).min(1),
        action: z.enum(["move", "copy", "read", "unread", "star", "unstar", "delete"]),
        dest: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const { folder, uids } = input;
      switch (input.action) {
        case "move":
          if (!input.dest) throw new Error("缺少目标文件夹");
          await moveMessages(account, folder, uids, input.dest);
          break;
        case "copy":
          if (!input.dest) throw new Error("缺少目标文件夹");
          await copyMessages(account, folder, uids, input.dest);
          break;
        case "read":
          await setFlag(account, folder, uids, "\\Seen", true);
          break;
        case "unread":
          await setFlag(account, folder, uids, "\\Seen", false);
          break;
        case "star":
          await setFlag(account, folder, uids, "\\Flagged", true);
          break;
        case "unstar":
          await setFlag(account, folder, uids, "\\Flagged", false);
          break;
        case "delete":
          await deleteMessages(account, folder, uids, "trash");
          break;
      }
      // 旗帜/数量刚被改过，未读数缓存立即作废，前端刷新拿到新值
      statusCache.delete(input.accountId);
      starredCache.delete(input.accountId);
      return { ok: true };
    }),

  /** 星标邮件：跨文件夹扫描 \Flagged（30 秒缓存） */
  starred: authedQuery
    .input(z.object({ accountId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const cached = starredCache.get(input.accountId);
      if (cached && Date.now() - cached.at < 30_000) return cached.data;
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const folders = await listFolders(account);
      const out: Awaited<ReturnType<typeof fetchRecentMessages>> = [];
      for (const f of folders) {
        try {
          const msgs = await fetchRecentMessages(account, f.path, 50);
          out.push(...msgs.filter((m) => m.starred));
        } catch {
          /* 个别文件夹不可读则跳过 */
        }
      }
      out.sort((a, b) => +new Date(b.date) - +new Date(a.date));
      starredCache.set(input.accountId, { at: Date.now(), data: out });
      return out;
    }),

  /** 当前文件夹全部标为已读 */
  markAllRead: authedQuery
    .input(z.object({ accountId: z.number().int(), folder: z.string().default("INBOX") }))
    .mutation(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const msgs = await fetchMessagesByUid(account, input.folder, 1);
      const unread = msgs.filter((m) => !m.seen).map((m) => m.uid);
      if (unread.length > 0) await setFlag(account, input.folder, unread, "\\Seen", true);
      statusCache.delete(input.accountId);
      starredCache.delete(input.accountId);
      return { ok: true, marked: unread.length };
    }),

  send: authedQuery
    .input(
      z.object({
        accountId: z.number().int(),
        /** 支持逗号分隔多个地址 */
        to: z.string().min(3).max(1000),
        cc: z.string().max(1000).optional(),
        subject: z.string().min(1),
        text: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const valid = (s: string) =>
        s.split(/[,，;；\s]+/).filter(Boolean).every((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
      if (!valid(input.to)) throw new Error("收件人地址格式不正确");
      if (input.cc && !valid(input.cc)) throw new Error("抄送地址格式不正确");
      const { accountId, ...mail } = input;
      await sendMail(account, mail);
      // 发出去的地址也入通讯录（默认关闭）
      if (await boolSettingOf(ctx.user.id, "collectContacts")) {
        void upsertContacts(ctx.user.id, [
          ...input.to.split(/[,，;；\s]+/).filter(Boolean).map((email) => ({ email })),
          ...(input.cc ?? "").split(/[,，;；\s]+/).filter(Boolean).map((email) => ({ email })),
        ]).catch(() => {});
      }
      return { ok: true };
    }),

  /** 给自己发一封测试邮件，方便空收件箱时调试分拣规则 */
  sendTest: authedQuery
    .input(z.object({ accountId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const account = await requireAccount(ctx, input.accountId);
      if (!account) throw new Error("账号不存在");
      const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
      await sendMail(account, {
        to: account.email,
        subject: `分拣测试邮件 ${stamp}`,
        text: [
          "这是一封自动生成的分拣测试邮件。",
          "",
          "常见调试玩法：",
          "1. 在规则页用「AI 诊断」生成规则；",
          "2. 回到这里点「执行分拣」看预览效果；",
          "3. 确认执行后不满意可点「还原」回滚。",
          "",
          `发送时间：${stamp}`,
        ].join("\n"),
      });
      return { ok: true };
    }),
});
