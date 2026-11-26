import { z } from "zod";
import type { ConditionGroup, RuleAction } from "@contracts/rules";
import { createRouter, authedQuery } from "./middleware";
import { getAccountFull } from "./queries/accounts";
import { fetchBodyTexts, fetchRecentMessages, listFolders } from "./mail/imap";
import {
  AI_BODY_CHARS,
  AI_MAX_MESSAGES,
  buildDiagnosePrompt,
  buildInstructPrompt,
  DEFAULT_DIAGNOSE_SYSTEM,
  INSTRUCT_SYSTEM,
  parseAiResponse,
  truncateForPrompt,
} from "@contracts/ai-rules";
import { callChatCompletions } from "./lib/ai-llm";
import { numSettingOf, saveAiConfig } from "./settings-router";
import { cleanupOrphanFolders } from "./mail/folder-cleanup";
import {
  createRule,
  deleteRule,
  listRules,
  listRulesForAccount,
  reorderRules,
  updateRule,
} from "./queries/rules";
import { rowToRuleDef, toEvalMessage } from "./mail/engine";
import { matchRules } from "@contracts/rules";

const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.object({
    op: z.enum(["all", "any"]),
    conditions: z.array(
      z.object({
        field: z.enum([
          "from",
          "from_name",
          "to",
          "cc",
          "subject",
          "body",
          "any_header",
          "header",
          "list_id",
          "size_kb",
          "age_days",
          "has_attach",
        ]),
        op: z.enum([
          "is",
          "not_is",
          "contains",
          "not_contains",
          "starts_with",
          "ends_with",
          "domain_is",
          "domain_suffix",
          "regex",
          "gt",
          "gte",
          "lt",
          "lte",
          "is_true",
          "is_false",
          "in_list",
          "not_in_list",
        ]),
        name: z.string().optional(),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
      }),
    ),
    groups: z.array(conditionGroupSchema).optional(),
  }),
);

const ruleInput = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  accountId: z.number().int().nullable().default(null),
  match: conditionGroupSchema,
  actions: z.array(
    z.object({
      type: z.enum([
        "move",
        "mark_read",
        "mark_unread",
        "star",
        "unstar",
        "delete",
        "archive",
        "spam",
        "set_flag",
        "notify",
        "assign_category",
      ]),
      folder: z.string().optional(),
      auto_create: z.boolean().optional(),
      flag: z.string().optional(),
      level: z.enum(["banner", "silent"]).optional(),
      category: z.string().optional(),
    }),
  ) as z.ZodType<RuleAction[]>,
  stop: z.boolean().default(false),
  packKey: z.string().max(80).nullable().optional(),
});

export const ruleRouter = createRouter({
  list: authedQuery
    .input(z.object({ accountId: z.number().int().nullable().optional() }))
    .query(async ({ ctx, input }) => {
      const rows = await listRules(ctx.user.id, input.accountId ?? null);
      return rows.map((r) => ({
        ...r,
        matchJson: JSON.parse(r.matchJson) as ConditionGroup,
        actionsJson: JSON.parse(r.actionsJson) as RuleAction[],
      }));
    }),

  create: authedQuery.input(ruleInput).mutation(async ({ ctx, input }) => {
    const { match, actions, ...meta } = input;
    const max = await listRules(ctx.user.id, null);
    await createRule(ctx.user.id, {
      ...meta,
      matchJson: JSON.stringify(match),
      actionsJson: JSON.stringify(actions),
      orderIndex: max.length,
    });
    return { ok: true };
  }),

  update: authedQuery
    .input(ruleInput.partial().extend({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const { id, match, actions, ...meta } = input;
      await updateRule(ctx.user.id, id, {
        ...meta,
        ...(match ? { matchJson: JSON.stringify(match) } : {}),
        ...(actions ? { actionsJson: JSON.stringify(actions) } : {}),
      });
      return { ok: true };
    }),

  /**
   * 导入外部规则包（系统与系统间共享的导出文件）。
   * 格式: { format: "mail-triage-pack@1", name: string, rules: [...] }
   * 同名规则跳过；导入后规则归入以包名命名的分组。
   */
  importShared: authedQuery
    .input(
      z.object({
        name: z.string().min(1).max(80),
        rules: z.array(
          z.object({
            name: z.string().min(1).max(200),
            enabled: z.boolean().optional(),
            stop: z.boolean().optional(),
            match: ruleInput.shape.match,
            actions: ruleInput.shape.actions,
          }),
        ),
        /** 来源标记：ai AI诊断导入 / user 用户导入（默认 user） */
        origin: z.enum(["ai", "user"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await listRules(ctx.user.id, null);
      const names = new Set(existing.map((r) => r.name));
      let added = 0;
      for (const rule of input.rules) {
        if (names.has(rule.name)) continue;
        await createRule(ctx.user.id, {
          name: rule.name,
          enabled: rule.enabled ?? true,
          accountId: null,
          matchJson: JSON.stringify(rule.match),
          actionsJson: JSON.stringify(rule.actions),
          orderIndex: existing.length + added,
          stop: rule.stop ?? false,
          packKey: input.name,
          packOrigin: input.origin ?? "user",
        });
        added++;
      }
      return { added, skipped: input.rules.length - added };
    }),

  remove: authedQuery
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      await deleteRule(ctx.user.id, input.id);
      // 规则删完后，不再被引用且已清空的自建文件夹一并清掉（异步，不阻塞）
      void cleanupOrphanFolders(ctx.user.id).catch(() => {});
      return { ok: true };
    }),

  reorder: authedQuery
    .input(z.object({ ids: z.array(z.number().int()) }))
    .mutation(async ({ ctx, input }) => {
      await reorderRules(ctx.user.id, input.ids);
      return { ok: true };
    }),

  /**
   * AI 诊断：拉取账号各文件夹近期邮件（正文固定长度截断，省 token），
   * 交给用户配置的模型分析，返回建议的规则包（不落库，由用户勾选后导入）。
   */
  aiDiagnose: authedQuery
    .input(
      z.object({
        accountId: z.number().int(),
        apiKey: z.string().min(1),
        model: z.string().min(1),
        baseUrl: z.string().min(1),
        /** 追加的用户要求（可选） */
        extraPrompt: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await getAccountFull(ctx.user.id, input.accountId);
      if (!account) throw new Error("账号不存在");

      // 模型配置配一次即可：每次诊断自动记住本次用的配置
      await saveAiConfig(ctx.user.id, {
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: input.apiKey,
      });

      // 取样上限来自设置页（省 token 的可调范围）
      const perFolder = await numSettingOf(ctx.user.id, "aiPerFolder");
      const maxTotal = await numSettingOf(ctx.user.id, "aiTotal");

      // 收集邮件摘要：每文件夹限量、总量限量
      const folders = await listFolders(account);
      const picked: { folder: string; uid: number; subject: string; from: string; to: string[] }[] = [];
      for (const f of folders) {
        if (picked.length >= maxTotal) break;
        try {
          const msgs = await fetchRecentMessages(account, f.path, perFolder);
          for (const m of msgs) {
            if (picked.length >= maxTotal) break;
            picked.push({
              folder: f.path,
              uid: m.uid,
              subject: m.subject,
              from: m.fromAddr,
              to: m.to,
            });
          }
        } catch {
          /* 个别文件夹不可读则跳过 */
        }
      }
      if (picked.length === 0) throw new Error("没有可分析的邮件");

      // 批量拉正文（每个文件夹一次会话），固定长度截断
      const byFolder = new Map<string, number[]>();
      for (const p of picked) {
        const arr = byFolder.get(p.folder) ?? [];
        arr.push(p.uid);
        byFolder.set(p.folder, arr);
      }
      const bodyMap = new Map<string, string>();
      for (const [folder, uids] of byFolder) {
        try {
          const texts = await fetchBodyTexts(account, folder, uids);
          for (const [uid, text] of texts) {
            bodyMap.set(`${folder}:${uid}`, truncateForPrompt(text, AI_BODY_CHARS));
          }
        } catch {
          for (const uid of uids) bodyMap.set(`${folder}:${uid}`, "");
        }
      }

      const digest = picked.map((p) => ({
        folder: p.folder,
        subject: p.subject,
        from: p.from,
        to: p.to,
        body: bodyMap.get(`${p.folder}:${p.uid}`) ?? "",
      }));

      const userPrompt =
        `以下是 ${digest.length} 封邮件的摘要（正文已截断为前 ${AI_BODY_CHARS} 字）。` +
        (input.extraPrompt ? `\n用户的额外要求：${input.extraPrompt}` : "") +
        `\n\n${buildDiagnosePrompt(digest)}`;

      const raw = await callChatCompletions({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        system: DEFAULT_DIAGNOSE_SYSTEM,
        user: userPrompt,
      });

      const result = parseAiResponse(raw);
      if (result.rules.length === 0) {
        throw new Error(
          `模型没有给出可用规则${result.skipped ? `（${result.skipped} 条因不合法被过滤）` : ""}，请调整要求重试`,
        );
      }
      return result;
    }),

  /**
   * AI 指令式建规则：用户看着预览清单直接下一句话指令（如「tencent.com
   * 后缀的邮件放入云厂商」），以收件箱现有邮件（仅主题+发件人）做上下文，
   * 只为这句指令出规则；不取正文，轻量快速。导入后由前端重新跑预览形成闭环。
   */
  aiInstruct: authedQuery
    .input(
      z.object({
        accountId: z.number().int(),
        instruction: z.string().min(1).max(500),
        apiKey: z.string().min(1),
        model: z.string().min(1),
        baseUrl: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await getAccountFull(ctx.user.id, input.accountId);
      if (!account) throw new Error("账号不存在");

      await saveAiConfig(ctx.user.id, {
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: input.apiKey,
      });

      // 上下文 = 收件箱近期邮件头部（预览的正是这个范围，规则也只对收件箱生效）
      const messages = await fetchRecentMessages(account, "INBOX", AI_MAX_MESSAGES);
      if (messages.length === 0) throw new Error("收件箱是空的，没有可参照的邮件");
      const items = messages.map((m) => ({ subject: m.subject, from: m.fromAddr }));

      const raw = await callChatCompletions({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        system: INSTRUCT_SYSTEM,
        user: buildInstructPrompt(input.instruction, items),
      });

      const result = parseAiResponse(raw);
      if (result.rules.length === 0) {
        throw new Error(
          `模型没有给出可用规则${result.skipped ? `（${result.skipped} 条因不合法被过滤）` : ""}，换个说法重试`,
        );
      }
      return result;
    }),

  /** 试算：对某账号最近 N 封邮件模拟规则命中，不执行动作 */
  dryRun: authedQuery
    .input(z.object({ accountId: z.number().int(), folder: z.string().default("INBOX"), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const account = await getAccountFull(ctx.user.id, input.accountId);
      if (!account) throw new Error("账号不存在");
      const rows = await listRulesForAccount(ctx.user.id, input.accountId);
      const messages = await fetchRecentMessages(account, input.folder, input.limit);
      const defs = rows.map(rowToRuleDef);
      const hits = messages.map((m) => {
        const matched = matchRules(defs, toEvalMessage(m));
        return {
          uid: m.uid,
          subject: m.subject,
          from: m.fromAddr,
          rules: matched.map((h) => h.rule.id),
        };
      });
      return { total: messages.length, hits: hits.filter((h) => h.rules.length > 0), rules: defs.map((d) => ({ id: d.id, name: d.name })) };
    }),
});
