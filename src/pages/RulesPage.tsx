import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Bot, Download, FlaskConical, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import type { ConditionField, ConditionOp, RuleAction, ActionType } from "@contracts/rules";
import { trpc } from "@/providers/trpc";
import { useAccounts } from "@/lib/accounts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import AiDiagnoseDialog from "@/components/AiDiagnoseDialog";

const FIELD_LABEL: Record<ConditionField, string> = {
  from: "发件人",
  from_name: "发件人名称",
  to: "收件人",
  cc: "抄送",
  subject: "主题",
  body: "正文",
  any_header: "任意头部",
  header: "指定头部",
  list_id: "来自讨论组",
  size_kb: "大小(KB)",
  age_days: "天数",
  has_attach: "有附件",
};

/** 编辑器里只露普通用户看得懂、真会用的字段（引擎仍支持全部，老规则不受影响） */
const USER_FIELDS: ConditionField[] = ["from", "to", "cc", "subject", "body", "has_attach", "list_id"];

/** 普通用户能懂的操作符 */
const USER_OPS: ConditionOp[] = ["contains", "not_contains", "is", "not_is", "starts_with", "ends_with", "domain_suffix"];

const OP_LABEL: Record<ConditionOp, string> = {
  is: "是",
  not_is: "不是",
  contains: "包含",
  not_contains: "不包含",
  starts_with: "开头是",
  ends_with: "结尾是",
  domain_is: "域名是",
  domain_suffix: "来自域名",
  regex: "正则匹配",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  is_true: "是",
  is_false: "不是",
  in_list: "在列表中",
  not_in_list: "不在列表中",
};

const ACTION_LABEL: Record<ActionType, string> = {
  move: "移动到文件夹",
  spam: "移入垃圾箱",
  delete: "删除",
  mark_read: "标为已读",
  mark_unread: "标为未读",
  star: "加星标",
  unstar: "取消星标",
};

const NUM_OPS: ConditionOp[] = ["gt", "gte", "lt", "lte"];
const BOOL_OPS: ConditionOp[] = ["is_true", "is_false"];
const NO_VALUE_OPS: ConditionOp[] = [...BOOL_OPS];

interface CondDraft {
  field: ConditionField;
  op: ConditionOp;
  name: string;
  value: string;
}

interface RuleDraft {
  id: number | null;
  name: string;
  accountId: number | null;
  packName: string;
  stop: boolean;
  conditions: CondDraft[];
  op: "all" | "any";
  actions: { type: ActionType; folder: string }[];
}

const emptyDraft = (): RuleDraft => ({
  id: null,
  name: "",
  accountId: null,
  packName: "",
  stop: false,
  conditions: [{ field: "from", op: "contains", name: "", value: "" }],
  op: "all",
  actions: [{ type: "move", folder: "" }],
});

export default function RulesPage() {
  const { selectedId } = useAccounts();
  const utils = trpc.useUtils();
  const rulesQuery = trpc.rule.list.useQuery({ accountId: null });

  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const [dryRunFor, setDryRunFor] = useState<number | null>(null);
  const [expandedPack, setExpandedPack] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);

  const toggle = trpc.rule.update.useMutation({
    onSuccess: () => utils.rule.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.rule.remove.useMutation({
    onSuccess: () => {
      toast.success("已删除");
      utils.rule.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const reorder = trpc.rule.reorder.useMutation({
    onSuccess: () => utils.rule.list.invalidate(),
  });
  // 规则保存后立即在当前账号收件箱执行一次，改动即刻生效
  const runAfterSave = trpc.mail.runRules.useMutation({
    onSuccess: (r) => {
      toast.success(`规则已保存并立即执行：命中 ${r.matched} 封`, {
        description: r.errors.length > 0 ? r.errors[0] : undefined,
      });
      void utils.mail.list.invalidate();
      void utils.mail.folderStatus.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const importShared = trpc.rule.importShared.useMutation({
    onSuccess: (r) => {
      toast.success(`已导入 ${r.added} 条规则${r.skipped ? `，跳过 ${r.skipped} 条同名` : ""}`);
      utils.rule.list.invalidate();
    },
    onError: (e) => toast.error(`导入失败：${e.message}`),
  });

  /** 导出规则包为 JSON 文件，可导入其他系统 */
  const exportPack = (name: string, list: typeof rules) => {
    const payload = {
      format: "mail-triage-pack@1",
      name,
      exportedAt: new Date().toISOString(),
      rules: list.map((r) => ({
        name: r.name,
        enabled: r.enabled,
        stop: r.stop,
        match: r.matchJson,
        actions: r.actionsJson,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.mailpack.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data.name || !Array.isArray(data.rules)) {
          throw new Error("不是有效的规则包文件");
        }
        importShared.mutate({ name: String(data.name).slice(0, 80), rules: data.rules, origin: "user" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "解析文件失败");
      }
    };
    reader.readAsText(file);
  };

  const rules = rulesQuery.data ?? [];
  const autoRules = rules.filter((r) => r.packKey === "auto-generated");
  // 用户包 / AI 包：packKey 不是自动创建包的分组，按来源再分
  const userPacks = new Map<string, typeof rules>();
  const aiPacks = new Map<string, typeof rules>();
  for (const r of rules) {
    if (!r.packKey || r.packKey === "auto-generated") continue;
    const target = r.packOrigin === "ai" ? aiPacks : userPacks;
    const list = target.get(r.packKey) ?? [];
    list.push(r);
    target.set(r.packKey, list);
  }
  const packBadge = (key: string | null): string => {
    if (!key) return "";
    return key === "auto-generated" ? "自动创建包" : key;
  };
  /** 编辑器「规则包名」下拉候选：已有用户包、AI 包、自动创建包 */
  const packOptions = [
    ...new Set([...[...userPacks.keys()], ...[...aiPacks.keys()], "自动创建包"]),
  ];
  /** 包徽标配色：来源一目了然 */
  const packBadgeClass = (key: string | null, origin: string | null): string => {
    if (origin === "ai") return "bg-violet-500/10 text-violet-600 dark:text-violet-400 hover:bg-violet-500/10";
    if (key === "auto-generated") return "bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10";
    if (key) return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10";
    return "";
  };

  const move = (index: number, dir: -1 | 1) => {
    const ids = rules.map((r) => r.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    reorder.mutate({ ids });
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">分拣规则</h1>
            <p className="text-sm text-muted-foreground">
              从上到下依次匹配；命中的邮件会立即执行动作
            </p>
          </div>
          <Button onClick={() => setEditing(emptyDraft())}>
            <Plus className="mr-1 h-4 w-4" /> 新建规则
          </Button>
        </div>

        {rules.length === 0 && !rulesQuery.isLoading && (
          <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            还没有规则。新建一条，或点右侧「AI 诊断」根据你的邮件自动生成。
          </p>
        )}

        <div className="space-y-2">
          {rules.map((r, i) => (
            <div
              key={r.id}
              className={cn(
                "flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3",
                !r.enabled && "opacity-55",
              )}
            >
              <div className="flex flex-col">
                <button className="text-muted-foreground hover:text-foreground" onClick={() => move(i, -1)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button className="text-muted-foreground hover:text-foreground" onClick={() => move(i, 1)}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{r.name}</span>
                  {r.packKey && (
                    <Badge variant="secondary" className={packBadgeClass(r.packKey, r.packOrigin)}>
                      {packBadge(r.packKey)}
                    </Badge>
                  )}
                  {r.hitCount > 0 && (
                    <Badge variant="outline" className="text-xs">
                      命中 {r.hitCount}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {summarizeRule(r.matchJson, r.actionsJson)}
                </p>
              </div>
              <Switch
                checked={r.enabled}
                onCheckedChange={(v) => toggle.mutate({ id: r.id, enabled: v })}
              />
              <Button size="sm" variant="ghost" onClick={() => setDryRunFor(r.id)} title="试算最近邮件">
                <FlaskConical className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setEditing({
                    id: r.id,
                    name: r.name,
                    accountId: r.accountId,
                    packName: r.packKey ?? "",
                    stop: r.stop,
                    op: r.matchJson.op,
                    conditions: r.matchJson.conditions.map((c) => ({
                      field: c.field,
                      op: c.op,
                      name: c.name ?? "",
                      value: Array.isArray(c.value) ? c.value.join(", ") : String(c.value ?? ""),
                    })),
                    actions: (r.actionsJson as RuleAction[]).map((a) => ({
                      type: a.type,
                      folder: a.folder ?? "",
                    })),
                  })
                }
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => remove.mutate({ id: r.id })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* 规则包：分区配色，来源一目了然 */}
      <div className="w-80 shrink-0 overflow-y-auto border-l border-border bg-secondary/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">规则包</h2>
          <label className="cursor-pointer text-xs text-primary hover:underline">
            导入规则包
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onImportFile(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>

        {/* AI 诊断入口 */}
        <button
          className="mb-4 flex w-full items-center gap-3 rounded-lg border border-violet-500/40 bg-gradient-to-r from-violet-500/10 to-fuchsia-500/10 px-4 py-3 text-left transition-colors hover:from-violet-500/20 hover:to-fuchsia-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setAiOpen(true)}
          disabled={!selectedId}
          title={selectedId ? undefined : "请先在左侧选择一个邮箱账号"}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-500/15">
            <Bot className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </span>
          <span>
            <span className="block text-sm font-medium">AI 诊断</span>
            <span className="block text-xs text-muted-foreground">
              分析邮件自动生成规则，勾选确认后导入
            </span>
          </span>
          <Sparkles className="ml-auto h-4 w-4 shrink-0 text-violet-500" />
        </button>

        <div className="space-y-4">
          {/* 我的规则包 */}
          {[...userPacks.entries()].map(([name, list]) => (
            <PackCard
              key={name}
              name={name}
              list={list}
              accent="emerald"
              expanded={expandedPack === `user:${name}`}
              onToggle={() => setExpandedPack(expandedPack === `user:${name}` ? null : `user:${name}`)}
              onExport={() => exportPack(name, list)}
              originLabel="手动创建 / 文件导入"
            />
          ))}

          {/* 智能生成的包：AI 诊断 + 自动分析，同一类「机器建议」 */}
          {(aiPacks.size > 0 || autoRules.length > 0) && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <span className="h-2 w-2 rounded-full bg-gradient-to-r from-violet-500 to-amber-500" />
                智能生成的包
              </p>
              <div className="space-y-2">
                {[...aiPacks.entries()].map(([name, list]) => (
                  <PackCard
                    key={name}
                    name={name}
                    list={list}
                    accent="violet"
                    expanded={expandedPack === `ai:${name}`}
                    onToggle={() => setExpandedPack(expandedPack === `ai:${name}` ? null : `ai:${name}`)}
                    onExport={() => exportPack(name, list)}
                    originLabel="AI 诊断生成"
                  />
                ))}
                {autoRules.length > 0 && (
                  <PackCard
                    name="自动创建包"
                    list={autoRules}
                    accent="amber"
                    expanded={expandedPack === "auto"}
                    onToggle={() => setExpandedPack(expandedPack === "auto" ? null : "auto")}
                    onExport={() => exportPack("自动创建包", autoRules)}
                    originLabel="根据收件箱邮件自动分析生成"
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <RuleEditor
          draft={editing}
          packOptions={packOptions}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            utils.rule.list.invalidate();
            if (selectedId) {
              runAfterSave.mutate({ accountId: selectedId, folder: "INBOX" });
            }
          }}
        />
      )}

      {dryRunFor !== null && selectedId && (
        <DryRunDialog ruleId={dryRunFor} accountId={selectedId} onClose={() => setDryRunFor(null)} />
      )}

      {aiOpen && selectedId && (
        <AiDiagnoseDialog accountId={selectedId} onClose={() => setAiOpen(false)} />
      )}
    </div>
  );
}

type Accent = "emerald" | "violet" | "amber";

const ACCENT_DOT: Record<Accent, string> = {
  emerald: "bg-emerald-500",
  violet: "bg-violet-500",
  amber: "bg-amber-500",
};
const ACCENT_BORDER: Record<Accent, string> = {
  emerald: "border-emerald-500/40",
  violet: "border-violet-500/40",
  amber: "border-amber-500/40",
};

/** 已导入的规则包卡片：彩色标识来源，可展开看规则、可导出 */
type SummarizableRule = {
  id: number;
  name: string;
  matchJson: Parameters<typeof summarizeRule>[0];
  actionsJson: Parameters<typeof summarizeRule>[1];
};

function PackCard({
  name,
  list,
  accent,
  expanded,
  onToggle,
  onExport,
  originLabel,
}: {
  name: string;
  list: SummarizableRule[];
  accent: Accent;
  expanded: boolean;
  onToggle: () => void;
  onExport: () => void;
  originLabel: string;
}) {
  return (
    <div className={cn("rounded-md border bg-card p-3", ACCENT_BORDER[accent])}>
      <button className="flex w-full items-center justify-between text-left" onClick={onToggle}>
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <span className={cn("h-2 w-2 rounded-full", ACCENT_DOT[accent])} />
          {name}
        </p>
        <Badge variant="secondary">{list.length} 条</Badge>
      </button>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{originLabel}</p>
      {expanded && (
        <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
          {list.map((r) => (
            <div key={r.id} className="rounded bg-secondary/50 px-2 py-1.5 text-xs">
              <p className="font-medium">{r.name}</p>
              <p className="mt-0.5 text-muted-foreground">
                {summarizeRule(r.matchJson, r.actionsJson)}
              </p>
            </div>
          ))}
        </div>
      )}
      <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onExport}>
        <Download className="mr-1 h-3.5 w-3.5" /> 导出
      </Button>
    </div>
  );
}

export function summarizeRule(match: { op: string; conditions: { field: string; op: string; value?: unknown }[] }, actions: { type: string; folder?: string }[]): string {
  const conds = match.conditions
    .map((c) => `${FIELD_LABEL[c.field as ConditionField] ?? c.field} ${OP_LABEL[c.op as ConditionOp] ?? c.op} ${fmtVal(c.value)}`)
    .join(` ${match.op === "all" ? "且" : "或"} `);
  const acts = actions
    .map((a) => (a.folder ? `${ACTION_LABEL[a.type as ActionType] ?? a.type} → ${a.folder}` : (ACTION_LABEL[a.type as ActionType] ?? a.type)))
    .join("、");
  return `${conds} ⇒ ${acts}`;
}

function fmtVal(v: unknown): string {
  if (v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.join("/");
  return String(v);
}

function RuleEditor({
  draft,
  packOptions,
  onClose,
  onSaved,
}: {
  draft: RuleDraft;
  packOptions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState(draft);
  const { accounts } = useAccounts();
  const create = trpc.rule.create.useMutation({ onSuccess: onSaved, onError: (e) => toast.error(e.message) });
  const update = trpc.rule.update.useMutation({ onSuccess: onSaved, onError: (e) => toast.error(e.message) });

  const setCond = (i: number, patch: Partial<CondDraft>) =>
    setD({ ...d, conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setAction = (i: number, patch: Partial<{ type: ActionType; folder: string }>) =>
    setD({ ...d, actions: d.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  const save = () => {
    if (!d.name.trim()) return toast.error("请填写规则名称");
    const match = {
      op: d.op,
      conditions: d.conditions
        .filter((c) => c.field !== "size_kb" && c.field !== "age_days" ? c.value.trim() || NO_VALUE_OPS.includes(c.op) || c.field === "has_attach" || c.op === "is_true" || c.op === "is_false" : c.value.trim())
        .map((c) => ({
          field: c.field,
          op: c.op,
          ...(c.field === "header" ? { name: c.name } : {}),
          value:
            c.field === "size_kb" || c.field === "age_days"
              ? Number(c.value)
              : c.op === "in_list" || c.op === "not_in_list" || c.op === "domain_is" || c.op === "domain_suffix"
                ? c.value.split(/[,，\s]+/).filter(Boolean)
                : c.value,
        })),
    };
    if (match.conditions.length === 0) return toast.error("至少需要一个条件");
    const actions = d.actions
      .filter((a) => a.type !== "move" || a.folder.trim())
      .map((a) => ({
        type: a.type,
        ...(a.type === "move" ? { folder: a.folder.trim(), auto_create: true } : {}),
      })) as RuleAction[];
    if (actions.length === 0) return toast.error("至少需要一个动作");
    const payload = {
      name: d.name.trim(),
      accountId: d.accountId,
      stop: d.stop,
      match,
      actions,
      // 包名为空 = 不属于任何包
      packKey: d.packName.trim() || null,
    };
    if (d.id === null) create.mutate(payload as never);
    else update.mutate({ id: d.id, ...payload } as never);
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{d.id === null ? "新建规则" : "编辑规则"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>名称</Label>
              <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="例如：验证码归档" />
            </div>
            <div className="space-y-1.5">
              <Label>应用到账号</Label>
              <Select
                value={d.accountId === null ? "all" : String(d.accountId)}
                onValueChange={(v) => setD({ ...d, accountId: v === "all" ? null : Number(v) })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部账号</SelectItem>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>{a.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>规则包名（可选）</Label>
              <Input
                value={d.packName}
                onChange={(e) => setD({ ...d, packName: e.target.value })}
                placeholder="从已有包中选择，或输入新包名"
                list="rule-pack-options"
              />
              <datalist id="rule-pack-options">
                {packOptions.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>条件（满足 {d.op === "all" ? "全部" : "任一"}）</Label>
              <Select value={d.op} onValueChange={(v) => setD({ ...d, op: v as "all" | "any" })}>
                <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部满足</SelectItem>
                  <SelectItem value="any">任一满足</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {d.conditions.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select value={c.field} onValueChange={(v) => setCond(i, { field: v as ConditionField, op: defaultOp(v as ConditionField) })}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {USER_FIELDS.map((f) => (
                      <SelectItem key={f} value={f}>{FIELD_LABEL[f]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {c.field === "header" && (
                  <Input className="w-36" placeholder="头部名，如 list-unsubscribe" value={c.name} onChange={(e) => setCond(i, { name: e.target.value })} />
                )}
                <Select value={c.op} onValueChange={(v) => setCond(i, { op: v as ConditionOp })}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[...opsFor(c.field), ...(opsFor(c.field).includes(c.op) ? [] : [c.op])].map((op) => (
                      <SelectItem key={op} value={op}>{OP_LABEL[op]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!NO_VALUE_OPS.includes(c.op) && (
                  <Input
                    className="flex-1"
                    placeholder={placeholderFor(c)}
                    value={c.value}
                    onChange={(e) => setCond(i, { value: e.target.value })}
                  />
                )}
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setD({ ...d, conditions: d.conditions.filter((_, j) => j !== i) })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => setD({ ...d, conditions: [...d.conditions, { field: "subject", op: "contains", name: "", value: "" }] })}>
              <Plus className="mr-1 h-3.5 w-3.5" /> 添加条件
            </Button>
          </div>

          <div className="space-y-2">
            <Label>动作</Label>
            {d.actions.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select value={a.type} onValueChange={(v) => setAction(i, { type: v as ActionType })}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(ACTION_LABEL).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {a.type === "move" && (
                  <Input className="flex-1" placeholder="目标文件夹，如 通知/验证码" value={a.folder} onChange={(e) => setAction(i, { folder: e.target.value })} />
                )}
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setD({ ...d, actions: d.actions.filter((_, j) => j !== i) })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => setD({ ...d, actions: [...d.actions, { type: "mark_read", folder: "" }] })}>
              <Plus className="mr-1 h-3.5 w-3.5" /> 添加动作
            </Button>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={create.isPending || update.isPending}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function defaultOp(field: ConditionField): ConditionOp {
  if (field === "size_kb" || field === "age_days") return "gt";
  if (field === "has_attach") return "is_true";
  if (field === "list_id") return "is_true";
  return "contains";
}

function opsFor(field: ConditionField): ConditionOp[] {
  if (field === "size_kb" || field === "age_days") return NUM_OPS;
  if (field === "has_attach" || field === "list_id") return BOOL_OPS;
  if (field === "from") return USER_OPS;
  return USER_OPS.filter((o) => o !== "domain_suffix");
}

function placeholderFor(c: CondDraft): string {
  if (c.op === "in_list" || c.op === "not_in_list" || c.op === "domain_is" || c.op === "domain_suffix")
    return "多个值用逗号分隔";
  if (c.field === "size_kb") return "如 1024";
  if (c.field === "age_days") return "如 30";
  return "匹配值";
}

function DryRunDialog({ ruleId, accountId, onClose }: { ruleId: number; accountId: number; onClose: () => void }) {
  const q = trpc.rule.dryRun.useQuery({ accountId, limit: 50 });
  const rule = q.data?.rules.find((r) => r.id === String(ruleId));
  const hits = (q.data?.hits ?? []).filter((h) => h.rules.includes(String(ruleId)));
  useEffect(() => {
    if (q.error) toast.error(q.error.message);
  }, [q.error]);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>试算：{rule?.name ?? ""}</DialogTitle>
        </DialogHeader>
        {q.isLoading && <p className="text-sm text-muted-foreground">正在拉取最近 50 封邮件…</p>}
        {q.data && (
          <p className="text-sm text-muted-foreground">
            最近 {q.data.total} 封中命中 <span className="font-semibold text-foreground">{hits.length}</span> 封（仅模拟，未执行动作）
          </p>
        )}
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {hits.map((h) => (
            <div key={h.uid} className="rounded border border-border px-3 py-1.5 text-sm">
              <span className="text-muted-foreground">{h.from}</span>
              <span className="mx-2">—</span>
              <span className="truncate">{h.subject}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
