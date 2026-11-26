import { describe, it, expect } from "vitest";
import {
  matchRules,
  planActions,
  evalGroup,
  testRule,
  domainOf,
  type EvalMessage,
  type RuleDef,
} from "./rules";

function msg(over: Partial<EvalMessage> = {}): EvalMessage {
  return {
    fromAddr: "alice@example.com",
    fromName: "Alice",
    to: ["me@test.com"],
    cc: [],
    subject: "Hello world",
    bodyText: "some body text",
    headers: {},
    listId: "",
    sizeKb: 10,
    ageDays: 1,
    hasAttach: false,
    folder: "INBOX",
    accountId: "acc1",
    read: false,
    starred: false,
    ...over,
  };
}

function rule(over: Partial<RuleDef> = {}): RuleDef {
  return {
    name: "r",
    enabled: true,
    priority: 100,
    match: { op: "all", conditions: [] },
    actions: [{ type: "move", folder: "X", auto_create: true }],
    ...over,
  };
}

describe("domainOf", () => {
  it("提取域名", () => {
    expect(domainOf("Alice <alice@mail.PROMO.example.com>")).toBe("mail.promo.example.com");
    expect(domainOf("no-at")).toBe("");
  });
});

describe("条件算子", () => {
  it("contains / not_contains", () => {
    const m = msg({ subject: "【限时秒杀】优惠券" });
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "subject", op: "contains", value: "秒杀" }] } }), m)).toBe(true);
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "subject", op: "not_contains", value: "秒杀" }] } }), m)).toBe(false);
  });

  it("domain_suffix 命中子域", () => {
    const m = msg({ fromAddr: "promo@mail.taobao.com" });
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "from", op: "domain_suffix", value: "taobao.com" }] } }), m)).toBe(true);
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "from", op: "domain_suffix", value: "obao.com" }] } }), m)).toBe(false);
  });

  it("domain_is 精确匹配", () => {
    const m = msg({ fromAddr: "a@sub.example.com" });
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "from", op: "domain_is", value: "example.com" }] } }), m)).toBe(false);
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "from", op: "domain_is", value: "sub.example.com" }] } }), m)).toBe(true);
  });

  it("regex", () => {
    const m = msg({ subject: "ALERT: CPU firing" });
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "subject", op: "regex", value: "^alert" }] } }), m)).toBe(true);
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "subject", op: "regex", value: "([" }] } }), m)).toBe(false); // 非法正则安全降级
  });

  it("数值比较 gt/lt", () => {
    const m = msg({ sizeKb: 2048, ageDays: 30 });
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "size_kb", op: "gt", value: 1024 }] } }), m)).toBe(true);
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "age_days", op: "lt", value: 7 }] } }), m)).toBe(false);
  });

  it("has_attach", () => {
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "has_attach", op: "is_true" }] } }), msg({ hasAttach: true }))).toBe(true);
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "has_attach", op: "is_true" }] } }), msg())).toBe(false);
  });

  it("list_id 存在", () => {
    const m = msg({ headers: { "list-id": "news.go.dev" } });
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "list_id", op: "regex", value: ".+" }] } }), m)).toBe(true);
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "list_id", op: "regex", value: ".+" }] } }), msg())).toBe(false);
  });

  it("header 指定头部", () => {
    const m = msg({ headers: { "x-alert-level": "critical" } });
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "header", name: "x-alert-level", op: "contains", value: "crit" }] } }), m)).toBe(true);
  });

  it("in_list / not_in_list", () => {
    const m = msg({ fromAddr: "a@foo.com" });
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "from", op: "in_list", value: ["a@foo.com", "b@bar.com"] }] } }), m)).toBe(true);
    expect(testRule(rule({ match: { op: "all", conditions: [{ field: "from", op: "not_in_list", value: ["a@foo.com"] }] } }), m)).toBe(false);
  });
});

describe("条件组组合", () => {
  it("all = AND, any = OR", () => {
    const m = msg({ subject: "hi", fromAddr: "x@y.com" });
    const rAnd = rule({ match: { op: "all", conditions: [
      { field: "subject", op: "contains", value: "hi" },
      { field: "from", op: "contains", value: "zzz" },
    ] } });
    const rOr = rule({ match: { op: "any", conditions: [
      { field: "subject", op: "contains", value: "hi" },
      { field: "from", op: "contains", value: "zzz" },
    ] } });
    expect(testRule(rAnd, m)).toBe(false);
    expect(testRule(rOr, m)).toBe(true);
  });

  it("嵌套子组", () => {
    const g = { op: "all" as const, conditions: [
      { field: "subject" as const, op: "contains" as const, value: "退款" },
    ], groups: [
      { op: "any" as const, conditions: [
        { field: "from" as const, op: "domain_suffix" as const, value: "taobao.com" },
        { field: "from" as const, op: "domain_suffix" as const, value: "jd.com" },
      ] },
    ] };
    expect(evalGroup(g, msg({ subject: "退款申请", fromAddr: "a@mail.jd.com" }))).toBe(true);
    expect(evalGroup(g, msg({ subject: "退款申请", fromAddr: "a@evil.com" }))).toBe(false);
  });
});

describe("matchRules", () => {
  it("priority 降序，stop 短路", () => {
    const rules = [
      rule({ name: "low", priority: 10, match: { op: "all", conditions: [{ field: "subject", op: "contains", value: "hi" }] }, actions: [{ type: "mark_read" }] }),
      rule({ name: "high", priority: 90, match: { op: "all", conditions: [{ field: "subject", op: "contains", value: "hi" }] }, actions: [{ type: "star" }] }),
    ];
    const hits = matchRules(rules, msg({ subject: "hi" }));
    expect(hits.map((h) => h.rule.name)).toEqual(["high"]);
  });

  it("stop:false 继续匹配", () => {
    const rules = [
      rule({ name: "a", priority: 90, stop: false, match: { op: "all", conditions: [{ field: "subject", op: "contains", value: "hi" }] }, actions: [{ type: "star" }] }),
      rule({ name: "b", priority: 10, match: { op: "all", conditions: [{ field: "subject", op: "contains", value: "hi" }] }, actions: [{ type: "mark_read" }] }),
    ];
    const hits = matchRules(rules, msg({ subject: "hi" }));
    expect(hits.map((h) => h.rule.name)).toEqual(["a", "b"]);
  });

  it("scope 过滤账号与文件夹", () => {
    const rules = [
      rule({ scope: { accounts: ["acc2"], folders: ["INBOX"] }, match: { op: "all", conditions: [{ field: "subject", op: "contains", value: "hi" }] } }),
    ];
    expect(matchRules(rules, msg({ subject: "hi", accountId: "acc1" }))).toHaveLength(0);
    expect(matchRules(rules, msg({ subject: "hi", accountId: "acc2" }))).toHaveLength(1);
    const folderScoped = [rule({ scope: { accounts: ["all"], folders: ["Archive"] }, match: { op: "all", conditions: [{ field: "subject", op: "contains", value: "hi" }] } })];
    expect(matchRules(folderScoped, msg({ subject: "hi", folder: "INBOX" }))).toHaveLength(0);
  });

  it("禁用的规则不参与", () => {
    const rules = [rule({ enabled: false, match: { op: "all", conditions: [{ field: "subject", op: "contains", value: "hi" }] } })];
    expect(matchRules(rules, msg({ subject: "hi" }))).toHaveLength(0);
  });

  it("planActions 去重合并", () => {
    const hits = matchRules(
      [
        rule({ name: "a", priority: 90, stop: false, match: { op: "all", conditions: [{ field: "subject", op: "contains", value: "hi" }] }, actions: [{ type: "mark_read" }, { type: "star" }] }),
        rule({ name: "b", priority: 10, match: { op: "all", conditions: [{ field: "subject", op: "contains", value: "hi" }] }, actions: [{ type: "mark_read" }, { type: "move", folder: "Auto/X" }] }),
      ],
      msg({ subject: "hi" })
    );
    const plan = planActions(hits);
    expect(plan.filter((a) => a.type === "mark_read")).toHaveLength(1);
    expect(plan.map((a) => a.type)).toContain("move");
  });
});
