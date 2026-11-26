/**
 * AI 诊断的纯函数：提示词拼装与模型输出解析。
 * 与 IMAP / HTTP 无关，便于单测。
 */
import type { ConditionField, ConditionOp, RuleAction } from "./rules";

/** 单封邮件喂给模型的最大正文字符数（省 token） */
export const AI_BODY_CHARS = 300;
/** 最多喂给模型的邮件总数 */
export const AI_MAX_MESSAGES = 120;

export interface AiMailDigest {
  folder: string;
  subject: string;
  from: string;
  to: string[];
  /** 已截断的正文 */
  body: string;
}

/** 固定长度截断：保留头部，超长标注 */
export function truncateForPrompt(text: string, maxChars: number = AI_BODY_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars) + "…";
}

/** 拼装给模型的邮件清单（紧凑格式，一行一封的头部 + 截断正文） */
export function buildDiagnosePrompt(messages: AiMailDigest[]): string {
  const lines = messages.map(
    (m, i) =>
      `#${i + 1} [${m.folder}] 主题: ${m.subject}\n发件人: ${m.from}\n收件人: ${m.to.join(", ")}\n正文: ${m.body || "(空)"}`,
  );
  return lines.join("\n---\n");
}

const ALLOWED_FIELDS = new Set<ConditionField>([
  "from",
  "from_name",
  "subject",
  "to",
  "cc",
  "list_id",
  "has_attach",
]);
const ALLOWED_OPS = new Set<ConditionOp>([
  "is",
  "not_is",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "domain_is",
  "domain_suffix",
  "in_list",
  "not_in_list",
  "is_true",
  "is_false",
]);
const ALLOWED_ACTIONS = new Set(["move", "mark_read", "mark_unread", "star", "unstar", "delete", "spam"]);

export interface AiRuleSuggestion {
  name: string;
  op: "all" | "any";
  conditions: { field: ConditionField; op: ConditionOp; value: unknown }[];
  actions: RuleAction[];
}

export interface AiDiagnoseResult {
  packName: string;
  rules: AiRuleSuggestion[];
  /** 模型给出但被过滤掉的条数（字段/动作不合法等） */
  skipped: number;
}

/** 从模型输出中提取 JSON（容忍 markdown 代码块包裹与前后杂音） */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型输出中没有 JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

/** 校验并规范化一条规则建议；不合法返回 null */
function normalizeRule(raw: unknown): AiRuleSuggestion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) return null;

  const condsRaw = Array.isArray(r.conditions) ? r.conditions : [];
  const conditions: AiRuleSuggestion["conditions"] = [];
  for (const c of condsRaw) {
    if (typeof c !== "object" || c === null) return null;
    const cc = c as Record<string, unknown>;
    if (typeof cc.field !== "string" || !(ALLOWED_FIELDS as Set<string>).has(cc.field)) return null;
    if (typeof cc.op !== "string" || !(ALLOWED_OPS as Set<string>).has(cc.op)) return null;
    const field = cc.field as ConditionField;
    const op = cc.op as ConditionOp;
    // 无值操作符统一不给 value；其余必须有值
    if (op === "is_true" || op === "is_false") {
      if (field === "has_attach") conditions.push({ field, op, value: true });
      else conditions.push({ field, op, value: undefined });
      continue;
    }
    const v = cc.value;
    if (v === undefined || v === null || v === "") return null;
    conditions.push({ field, op, value: v });
  }
  if (conditions.length === 0) return null;

  const actsRaw = Array.isArray(r.actions) ? r.actions : [];
  const actions: RuleAction[] = [];
  for (const a of actsRaw) {
    if (typeof a !== "object" || a === null) return null;
    const aa = a as Record<string, unknown>;
    if (typeof aa.type !== "string" || !ALLOWED_ACTIONS.has(aa.type)) return null;
    if (aa.type === "move") {
      if (typeof aa.folder !== "string" || !aa.folder.trim()) return null;
      actions.push({ type: "move", folder: aa.folder.trim(), auto_create: true } as RuleAction);
    } else {
      actions.push({ type: aa.type } as RuleAction);
    }
  }
  if (actions.length === 0) return null;

  return {
    name: r.name.trim().slice(0, 200),
    op: r.op === "any" ? "any" : "all",
    conditions,
    actions,
  };
}

/** 解析模型输出为规则建议；整条 JSON 解析失败时抛错 */
export function parseAiResponse(raw: string): AiDiagnoseResult {
  const data = extractJson(raw) as Record<string, unknown>;
  const rawRules = Array.isArray(data.rules) ? data.rules : [];
  const rules: AiRuleSuggestion[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const r of rawRules) {
    const norm = normalizeRule(r);
    if (!norm || seen.has(norm.name)) {
      skipped++;
      continue;
    }
    seen.add(norm.name);
    rules.push(norm);
  }
  const packName =
    typeof data.packName === "string" && data.packName.trim()
      ? data.packName.trim().slice(0, 80)
      : "AI 诊断规则包";
  return { packName, rules, skipped };
}

/** 指令式分拣：给模型一句用户要求 + 收件箱清单，只为这个要求出规则 */
export interface InstructMailItem {
  subject: string;
  from: string;
}

export function buildInstructPrompt(instruction: string, items: InstructMailItem[]): string {
  const lines = items.map(
    (m, i) => `#${i + 1} 主题: ${m.subject || "(无主题)"}\n发件人: ${m.from}`,
  );
  return (
    `用户的分拣要求：${instruction}\n\n` +
    `以下是收件箱现有邮件清单（供你判断条件写法与覆盖面，不要超出用户要求额外分类）：\n` +
    lines.join("\n---\n")
  );
}

export const INSTRUCT_SYSTEM = `你是邮件分拣规则设计助手。用户会给你一句分拣要求和他收件箱里的邮件清单。
只针对用户的要求输出规则，不要画蛇添足添加用户没要求的分类。输出严格 JSON（不要输出任何其他文字），格式：
{
  "packName": "规则包名（简短中文）",
  "rules": [
    {
      "name": "规则名（说明 来源 → 去向）",
      "op": "all",
      "conditions": [
        {"field": "from", "op": "domain_suffix", "value": ["tencent.com"]}
      ],
      "actions": [{"type": "move", "folder": "目标文件夹"}]
    }
  ]
}
要求：
1. field 只允许 from/from_name/subject/to/cc/list_id/has_attach；op 只允许 is/not_is/contains/not_contains/starts_with/ends_with/domain_is/domain_suffix/in_list/not_in_list/is_true/is_false；in_list/domain_is/domain_suffix 的 value 用数组。
2. action.type 只允许 move/mark_read/mark_unread/star/unstar/delete/spam；move 必须给 folder（简短中文文件夹名）。
3. 规则 1-5 条，每条 name 不超过 30 字；要求模糊时按最自然的理解执行。`;

/** 默认提示词：让模型按用户邮箱现状分类建包 */
export const DEFAULT_DIAGNOSE_SYSTEM = `你是邮件分拣规则设计助手。用户会给你一批邮件摘要（主题、发件人、收件人、截断正文）。
请把它们归类成 1 个规则包，输出严格 JSON（不要输出任何其他文字），格式：
{
  "packName": "规则包名（简短中文）",
  "rules": [
    {
      "name": "规则名（说明 来源 → 去向）",
      "op": "all",
      "conditions": [
        {"field": "from", "op": "domain_suffix", "value": "example.com"}
      ],
      "actions": [{"type": "move", "folder": "目标文件夹"}, {"type": "mark_read"}]
    }
  ]
}
要求：
1. field 只允许 from/from_name/subject/to/cc/list_id/has_attach；op 只允许 is/not_is/contains/not_contains/starts_with/ends_with/domain_is/domain_suffix/in_list/not_in_list/is_true/is_false；in_list/domain_is/domain_suffix 的 value 用数组。
2. action.type 只允许 move/mark_read/mark_unread/star/unstar/delete/spam；move 必须给 folder（用「类别/子类」形式，如 通知/验证码）。
3. 同类的邮件合并成一条规则，发件人按域名归组；真人来信不要归类（留在收件箱）。
4. 规则 5-15 条为宜，每条 name 不超过 30 字。`;
