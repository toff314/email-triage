import { useState } from "react";
import { FolderInput, Loader2, MailOpen, Sparkles, Star, Trash2 } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { summarizeRule } from "@/pages/RulesPage";

const FLAG_LABEL: Record<string, string> = {
  mark_read: "标为已读",
  mark_unread: "标为未读",
  star: "加星",
  unstar: "取消星",
  delete: "删除",
};

interface Item {
  uid: number;
  subject: string;
  from: string;
  dest: string | null;
  flags: string[];
  rules: string[];
}

interface SuggestedRule {
  name: string;
  op: "all" | "any";
  conditions: Parameters<typeof summarizeRule>[0]["conditions"];
  actions: Parameters<typeof summarizeRule>[1];
}

export default function RunPreviewDialog({
  accountId,
  folder,
  onConfirm,
  onClose,
}: {
  accountId: number;
  folder: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const preview = trpc.mail.previewRun.useQuery({ accountId, folder });
  const saved = trpc.settings.get.useQuery();

  const [instruction, setInstruction] = useState("");
  const [aiResult, setAiResult] = useState<{
    packName: string;
    rules: SuggestedRule[];
    skipped: number;
  } | null>(null);
  const [checked, setChecked] = useState<Record<number, boolean>>({});

  const instruct = trpc.rule.aiInstruct.useMutation({
    onSuccess: (r) => {
      setAiResult(r);
      setChecked(Object.fromEntries(r.rules.map((_, i) => [i, true])));
    },
    onError: (e) => toast.error(`生成失败：${e.message}`),
  });
  const importSelected = trpc.rule.importShared.useMutation({
    onSuccess: (r) => {
      toast.success(`已导入 ${r.added} 条规则${r.skipped ? `，跳过 ${r.skipped} 条同名` : ""}，预览已刷新`);
      void utils.rule.list.invalidate();
      void preview.refetch();
      setAiResult(null);
      setInstruction("");
    },
    onError: (e) => toast.error(`导入失败：${e.message}`),
  });

  const runInstruct = () => {
    if (!instruction.trim()) return;
    if (!saved.data?.aiKey || !saved.data.aiModel || !saved.data.aiBaseUrl) {
      return toast.error("还没有配置模型，请先在规则页的「AI 诊断」里填写");
    }
    if (!preview.data || preview.data.scanned === 0) return;
    instruct.mutate({
      accountId,
      instruction: instruction.trim(),
      apiKey: saved.data.aiKey,
      model: saved.data.aiModel,
      baseUrl: saved.data.aiBaseUrl,
    });
  };

  const doImport = () => {
    if (!aiResult) return;
    const rules = aiResult.rules.filter((_, i) => checked[i]);
    if (rules.length === 0) return toast.error("请至少勾选一条规则");
    importSelected.mutate({
      name: aiResult.packName,
      rules: rules.map((r) => ({
        name: r.name,
        match: { op: r.op, conditions: r.conditions },
        actions: r.actions,
      })),
      origin: "ai",
    });
  };


  const data = preview.data;
  const groups = new Map<string, Item[]>();
  for (const it of data?.items ?? []) {
    const key = it.dest ?? "__stay__";
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const moveCount = (data?.items ?? []).filter((i) => i.dest && i.dest !== "垃圾邮件").length;
  const spamCount = (data?.items ?? []).filter((i) => i.dest === "垃圾邮件").length;
  const flagCount = (data?.items ?? []).filter((i) => i.flags.length > 0).length;
  const deleteCount = (data?.items ?? []).filter((i) => i.flags.includes("delete")).length;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto overflow-x-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>分拣预览 · 未执行</DialogTitle>
          <DialogDescription>
            以下是规则对最近邮件的处理方案，确认无误再执行；执行后可用「还原」撤回移动
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}
        {preview.error && <p className="text-sm text-destructive">{preview.error.message}</p>}

        {data && data.scanned === 0 && (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            收件箱是空的，没有邮件可以预览。等收到新邮件后再试。
          </p>
        )}

        {data && data.scanned > 0 && data.matched === 0 && (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            收件箱最近 {data.scanned} 封邮件都没有命中任何规则，全部会留在原地。
          </p>
        )}

        {data && data.matched > 0 && (
          <div className="space-y-3">
            <p className="rounded-md bg-secondary/60 px-3 py-2 text-sm">
              扫描 <span className="font-semibold">{data.scanned}</span> 封，命中{" "}
              <span className="font-semibold">{data.matched}</span> 封
              {moveCount > 0 && <>，移动 {moveCount} 封</>}
              {spamCount > 0 && <>，进垃圾 {spamCount} 封</>}
              {flagCount > 0 && <>，标记 {flagCount} 封</>}
              {deleteCount > 0 && <span className="text-destructive">，删除 {deleteCount} 封</span>}
            </p>

            <div className="space-y-3">
              {sorted.map(([dest, items]) => (
                <div key={dest} className="rounded-md border border-border">
                  <p className="flex items-center gap-2 border-b border-border/60 bg-secondary/40 px-3 py-1.5 text-sm font-medium">
                    {dest === "__stay__" ? (
                      <>仅标记 · 留在原地</>
                    ) : dest === "垃圾邮件" ? (
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    ) : (
                      <FolderInput className="h-3.5 w-3.5 text-primary" />
                    )}
                    {dest !== "__stay__" && <span>移动到「{dest}」</span>}
                    <Badge variant="secondary">{items.length} 封</Badge>
                  </p>
                  <div className="max-h-44 divide-y divide-border/50 overflow-y-auto overflow-x-hidden">
                    {items.map((it) => (
                      <div key={it.uid} className="px-3 py-1.5 text-xs">
                        <p className="flex items-center gap-1.5">
                          <span className="max-w-[38%] shrink-0 truncate text-muted-foreground">
                            {it.from}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {it.subject || "(无主题)"}
                          </span>
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1">
                          {it.rules.map((r) => (
                            <Badge key={r} variant="outline" className="text-[10px]">
                              {r}
                            </Badge>
                          ))}
                          {it.flags.map((f) => (
                            <Badge key={f} variant="secondary" className="gap-0.5 text-[10px]">
                              {f === "mark_read" ? (
                                <MailOpen className="h-2.5 w-2.5" />
                              ) : f === "star" ? (
                                <Star className="h-2.5 w-2.5" />
                              ) : f === "delete" ? (
                                <Trash2 className="h-2.5 w-2.5" />
                              ) : null}
                              {FLAG_LABEL[f] ?? f}
                            </Badge>
                          ))}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {data.unmatched.length > 0 && (
              <details className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer text-sm">
                  无规则命中 {data.unmatched.length} 封，将留在原地
                </summary>
                <div className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto">
                  {data.unmatched.slice(0, 30).map((m) => (
                    <p key={m.uid} className="truncate">
                      <span className="text-muted-foreground">{m.from}</span> — {m.subject || "(无主题)"}
                    </p>
                  ))}
                  {data.unmatched.length > 30 && <p>…共 {data.unmatched.length} 封</p>}
                </div>
              </details>
            )}
          </div>
        )}

        {data && data.scanned > 0 && !aiResult && (
          <div className="mt-3 space-y-2 rounded-md border border-violet-500/30 bg-violet-500/5 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-violet-600 dark:text-violet-400">
              <Sparkles className="h-3.5 w-3.5" />
              看出来了怎么分？直接告诉 AI，生成规则后预览自动刷新
            </p>
            <div className="flex gap-2">
              <Input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runInstruct()}
                placeholder="如：tencent.com 后缀的邮件放入云厂商"
                maxLength={500}
              />
              <Button
                variant="outline"
                className="shrink-0 border-violet-500/40 text-violet-600 hover:bg-violet-500/10 hover:text-violet-600 dark:text-violet-400 dark:hover:text-violet-400"
                onClick={runInstruct}
                disabled={instruct.isPending || !instruction.trim()}
              >
                {instruct.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                生成规则
              </Button>
            </div>
          </div>
        )}

        {aiResult && (
          <div className="mt-3 space-y-2 rounded-md border border-violet-500/30 bg-violet-500/5 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-violet-600 dark:text-violet-400">
              <Sparkles className="h-3.5 w-3.5" />
              模型建议 {aiResult.rules.length} 条规则
              {aiResult.skipped > 0 && `，${aiResult.skipped} 条不合规被过滤`}
              ，勾选导入后预览自动刷新
            </p>
            <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
              {aiResult.rules.map((r, i) => (
                <label
                  key={i}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={!!checked[i]}
                    onCheckedChange={(v) => setChecked({ ...checked, [i]: v === true })}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{r.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {summarizeRule({ op: r.op, conditions: r.conditions }, r.actions)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setAiResult(null)}>
                重新输入
              </Button>
              <Button
                size="sm"
                onClick={doImport}
                disabled={importSelected.isPending}
              >
                {importSelected.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                导入并刷新预览
              </Button>
            </div>
          </div>
        )}

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={onConfirm} disabled={!data || data.matched === 0}>
            {data && data.matched > 0 ? `确认执行（${data.matched} 封）` : "没有命中的邮件"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
