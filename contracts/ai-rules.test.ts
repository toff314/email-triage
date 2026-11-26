import { describe, expect, it } from "vitest";
import {
  buildDiagnosePrompt,
  extractJson,
  parseAiResponse,
  truncateForPrompt,
} from "./ai-rules";

describe("truncateForPrompt", () => {
  it("保留原文（未超长）", () => {
    expect(truncateForPrompt("短正文", 300)).toBe("短正文");
  });
  it("超长截断并压空白", () => {
    const long = "a".repeat(400);
    const out = truncateForPrompt(long, 300);
    expect(out.length).toBe(301);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildDiagnosePrompt", () => {
  it("生成紧凑清单", () => {
    const p = buildDiagnosePrompt([
      { folder: "INBOX", subject: "s1", from: "a@x.com", to: ["me@x.com"], body: "body" },
    ]);
    expect(p).toContain("#1 [INBOX] 主题: s1");
    expect(p).toContain("正文: body");
  });
});

describe("extractJson", () => {
  it("容忍代码块包裹", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("容忍前后杂音", () => {
    expect(extractJson('好的 {"a":1} 完')).toEqual({ a: 1 });
  });
  it("无 JSON 抛错", () => {
    expect(() => extractJson("没有")).toThrow();
  });
});

describe("parseAiResponse", () => {
  const sample = JSON.stringify({
    packName: "通知归集包",
    rules: [
      {
        name: "GitHub → 工作/代码",
        op: "all",
        conditions: [{ field: "from", op: "domain_suffix", value: ["github.com"] }],
        actions: [{ type: "move", folder: "工作/代码" }, { type: "mark_read" }],
      },
      {
        name: "坏规则-未知动作",
        conditions: [{ field: "from", op: "contains", value: "x" }],
        actions: [{ type: "notify" }],
      },
      {
        name: "坏规则-无条件",
        conditions: [],
        actions: [{ type: "delete" }],
      },
      {
        name: "带附件标星",
        op: "all",
        conditions: [{ field: "has_attach", op: "is_true" }],
        actions: [{ type: "star" }],
      },
    ],
  });

  it("解析合法规则并统计被过滤的", () => {
    const r = parseAiResponse(sample);
    expect(r.packName).toBe("通知归集包");
    expect(r.rules.length).toBe(2);
    expect(r.skipped).toBe(2);
    expect(r.rules[0].conditions[0]).toEqual({
      field: "from",
      op: "domain_suffix",
      value: ["github.com"],
    });
    expect(r.rules[1].conditions[0].value).toBe(true);
  });

  it("容忍 markdown 包裹", () => {
    const r = parseAiResponse("```json\n" + sample + "\n```");
    expect(r.rules.length).toBe(2);
  });

  it("缺 packName 用默认名", () => {
    const r = parseAiResponse(JSON.stringify({ rules: [] }));
    expect(r.packName).toBe("AI 诊断规则包");
  });

  it("move 缺 folder 整条作废", () => {
    const r = parseAiResponse(
      JSON.stringify({
        rules: [
          { name: "x", conditions: [{ field: "subject", op: "contains", value: "a" }], actions: [{ type: "move" }] },
        ],
      }),
    );
    expect(r.rules.length).toBe(0);
    expect(r.skipped).toBe(1);
  });
});
