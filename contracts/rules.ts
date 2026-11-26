/**
 * 邮件分拣规则引擎 —— 纯函数，前后端共享。
 * 语义参考 imapfilter (Lua) / Sieve (RFC 5228) 的成熟条件-动作模型。
 */

// ---------- 类型 ----------

export type ConditionField =
  | "from" // 发件人地址
  | "from_name" // 发件人显示名
  | "to"
  | "cc"
  | "subject"
  | "body"
  | "any_header" // 任意头部值
  | "header" // 指定头部（需 name）
  | "list_id"
  | "size_kb"
  | "age_days"
  | "has_attach";

export type ConditionOp =
  | "is"
  | "not_is"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "domain_is"
  | "domain_suffix"
  | "regex"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is_true"
  | "is_false"
  | "in_list"
  | "not_in_list";

export interface RuleCondition {
  field: ConditionField;
  op: ConditionOp;
  /** header / list_id 等字段需要的头部名 */
  name?: string;
  /** 主比较值 */
  value?: string | number | boolean | string[];
}

export type ActionType =
  | "move" // 移动/归档到文件夹（auto_create 自动创建）
  | "mark_read"
  | "mark_unread"
  | "star"
  | "unstar"
  | "delete"
  | "archive"
  | "spam"
  | "set_flag"
  | "notify"
  | "assign_category"; // 应用内分类标签

export interface RuleAction {
  type: ActionType;
  folder?: string; // move 目标
  auto_create?: boolean; // move 时文件夹不存在则自动创建
  flag?: string; // set_flag
  level?: "banner" | "silent";
  category?: string; // assign_category 的分类 key
}

export interface ConditionGroup {
  op: "all" | "any";
  conditions: RuleCondition[];
  groups?: ConditionGroup[];
}

export interface RuleScope {
  accounts?: string[]; // "all" 或账号 id 列表
  folders?: string[]; // 默认 ["INBOX"]
}

export interface RuleDef {
  id?: string;
  name: string;
  enabled: boolean;
  priority: number; // 越大越先匹配
  match: ConditionGroup;
  actions: RuleAction[];
  scope?: RuleScope;
  stop?: boolean; // 命中后停止匹配后续规则
  packKey?: string; // 所属规则包
}

export type ViewMode = "focused" | "normal" | "junk" | "notice";

// ---------- 规则求值输入 ----------

export interface EvalMessage {
  fromAddr: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  headers: Record<string, string>; // 小写键
  listId?: string;
  sizeKb: number;
  ageDays: number;
  hasAttach: boolean;
  folder: string;
  accountId: string;
  read: boolean;
  starred: boolean;
}

export interface EvalContext {
  accountId: string;
}

// ---------- 工具 ----------

export function domainOf(addr: string): string {
  const m = addr.match(/@([^>]+)/);
  return m ? m[1].trim().toLowerCase() : "";
}

function getHeader(msg: EvalMessage, name: string): string {
  const v = msg.headers[name.toLowerCase()];
  return v ?? "";
}

function numeric(v: unknown): number {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : NaN;
}

function asList(v: string | number | boolean | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).toLowerCase());
  if (v === undefined) return [];
  return [String(v).toLowerCase()];
}

function evalCondition(cond: RuleCondition, msg: EvalMessage): boolean {
  // is_true / is_false 仅对布尔字段有"字面"语义；
  // 对文本字段则按"存在/不存在"理解（由后续分支处理）。
  if (cond.field === "has_attach") {
    return cond.op === "is_true" ? msg.hasAttach : !msg.hasAttach;
  }


  // 数值/布尔字段
  if (cond.field === "size_kb") {
    const n = numeric(cond.value);
    return cmpNum(msg.sizeKb, cond.op, n);
  }
  if (cond.field === "age_days") {
    const n = numeric(cond.value);
    return cmpNum(msg.ageDays, cond.op, n);
  }
  // 文本字段
  let haystack: string[];
  switch (cond.field) {
    case "from":
      haystack = [msg.fromAddr.toLowerCase()];
      break;
    case "from_name":
      haystack = [msg.fromName.toLowerCase()];
      break;
    case "to":
      haystack = msg.to.map((s) => s.toLowerCase());
      break;
    case "cc":
      haystack = msg.cc.map((s) => s.toLowerCase());
      break;
    case "subject":
      haystack = [msg.subject.toLowerCase()];
      break;
    case "body":
      haystack = [msg.bodyText.toLowerCase()];
      break;
    case "any_header":
      haystack = Object.values(msg.headers).map((s) => s.toLowerCase());
      break;
    case "header":
      haystack = [getHeader(msg, cond.name ?? "").toLowerCase()];
      break;
    case "list_id":
      haystack = [(msg.listId || getHeader(msg, "list-id")).toLowerCase()];
      break;
    default:
      return false;
  }
  const needles = asList(cond.value);

  switch (cond.op) {
    case "is_true":
      // 文本字段上：非空即真
      return haystack.some((h) => h.length > 0);
    case "is_false":
      return !haystack.some((h) => h.length > 0);
    case "is":
      return haystack.some((h) => needles.some((n) => h === n));
    case "not_is":
      return !haystack.some((h) => needles.some((n) => h === n));
    case "contains":
      return haystack.some((h) => needles.some((n) => h.includes(n)));
    case "not_contains":
      return !haystack.some((h) => needles.some((n) => h.includes(n)));
    case "starts_with":
      return haystack.some((h) => needles.some((n) => h.startsWith(n)));
    case "ends_with":
      return haystack.some((h) => needles.some((n) => h.endsWith(n)));
    case "domain_is":
      return needles.includes(domainOf(msg.fromAddr));
    case "domain_suffix": {
      const dom = domainOf(msg.fromAddr);
      return needles.some((n) => dom === n || dom.endsWith("." + n));
    }
    case "regex":
      return haystack.some((h) => {
        try {
          return new RegExp(String(cond.value ?? ""), "i").test(h);
        } catch {
          return false;
        }
      });
    case "in_list":
      return haystack.some((h) => needles.includes(h));
    case "not_in_list":
      return !haystack.some((h) => needles.includes(h));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      // 文本字段上的数值比较：比较长度（少见用法，保持确定性）
      const n = numeric(cond.value);
      if (Number.isNaN(n)) return false;
      return haystack.some((h) => cmpNum(h.length, cond.op, n));
    }
    default:
      return false;
  }
}

function cmpNum(actual: number, op: ConditionOp, n: number): boolean {
  switch (op) {
    case "gt":
      return actual > n;
    case "gte":
      return actual >= n;
    case "lt":
      return actual < n;
    case "lte":
      return actual <= n;
    case "is":
      return actual === n;
    case "not_is":
      return actual !== n;
    default:
      return false;
  }
}

export function evalGroup(group: ConditionGroup, msg: EvalMessage): boolean {
  const parts: boolean[] = group.conditions.map((c) => evalCondition(c, msg));
  for (const g of group.groups ?? []) {
    parts.push(evalGroup(g, msg));
  }
  if (parts.length === 0) return false;
  return group.op === "all" ? parts.every(Boolean) : parts.some(Boolean);
}

export interface RuleHit {
  rule: RuleDef;
  actions: RuleAction[];
}

/**
 * 按 priority 降序匹配，stop 短路；返回命中的规则及其动作（已按规则顺序展开）。
 */
export function matchRules(rules: RuleDef[], msg: EvalMessage): RuleHit[] {
  const sorted = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => b.priority - a.priority);
  const hits: RuleHit[] = [];
  for (const rule of sorted) {
    const scope = rule.scope ?? { accounts: ["all"], folders: ["INBOX"] };
    const accounts = scope.accounts ?? ["all"];
    if (!accounts.includes("all") && !accounts.includes(msg.accountId)) continue;
    const folders = scope.folders ?? ["INBOX"];
    if (!folders.includes("*") && !folders.includes(msg.folder)) continue;
    if (evalGroup(rule.match, msg)) {
      hits.push({ rule, actions: rule.actions });
      if (rule.stop !== false) break;
    }
  }
  return hits;
}

/** 把多条命中规则的动作合并为一条执行计划（去重、按类型稳定排序）。 */
export function planActions(hits: RuleHit[]): RuleAction[] {
  const out: RuleAction[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    for (const a of hit.actions) {
      const key = JSON.stringify(a);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

/** 单条规则快速求值（dry-run 用）。 */
export function testRule(rule: RuleDef, msg: EvalMessage): boolean {
  return evalGroup(rule.match, msg);
}
