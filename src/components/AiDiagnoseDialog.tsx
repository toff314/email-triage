import { useEffect, useState } from "react";
import { Bot, Loader2, Sparkles } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { summarizeRule } from "@/pages/RulesPage";

interface SuggestedRule {
  name: string;
  op: "all" | "any";
  conditions: Parameters<typeof summarizeRule>[0]["conditions"];
  actions: Parameters<typeof summarizeRule>[1];
}

export default function AiDiagnoseDialog({
  accountId,
  onClose,
}: {
  accountId: number;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  // 已保存的模型配置自动带出（诊断成功后服务端也会记住本次配置）
  const saved = trpc.settings.get.useQuery();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("kimi-k2.5");
  const [baseUrl, setBaseUrl] = useState("https://api.moonshot.cn/v1");
  const [extraPrompt, setExtraPrompt] = useState("");
  const [packName, setPackName] = useState("");
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [result, setResult] = useState<{
    packName: string;
    rules: SuggestedRule[];
    skipped: number;
  } | null>(null);

  useEffect(() => {
    if (!saved.data || loaded) return;
    if (saved.data.aiKey) setApiKey(saved.data.aiKey);
    if (saved.data.aiModel) setModel(saved.data.aiModel);
    if (saved.data.aiBaseUrl) setBaseUrl(saved.data.aiBaseUrl);
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data]);

  const diagnose = trpc.rule.aiDiagnose.useMutation({
    onSuccess: (r) => {
      setResult(r);
      setPackName(r.packName);
      setChecked(Object.fromEntries(r.rules.map((_, i) => [i, true])));
    },
    onError: (e) => toast.error(`诊断失败：${e.message}`),
  });
  const importSelected = trpc.rule.importShared.useMutation({
    onSuccess: (r) => {
      toast.success(
        `已导入 ${r.added} 条规则到「${packName}」${r.skipped ? `，跳过 ${r.skipped} 条同名` : ""}`,
      );
      void utils.rule.list.invalidate();
      onClose();
    },
    onError: (e) => toast.error(`导入失败：${e.message}`),
  });

  const selectedRules = (result?.rules ?? []).filter((_, i) => checked[i]);

  const run = () => {
    if (!apiKey.trim()) return toast.error("请填写 API-KEY");
    if (!model.trim()) return toast.error("请填写模型名");
    if (!baseUrl.trim()) return toast.error("请填写接口地址");
    diagnose.mutate({
      accountId,
      apiKey: apiKey.trim(),
      model: model.trim(),
      baseUrl: baseUrl.trim(),
      extraPrompt: extraPrompt.trim() || undefined,
    });
  };

  const doImport = () => {
    if (selectedRules.length === 0) return toast.error("请至少勾选一条规则");
    if (!packName.trim()) return toast.error("请填写规则包名");
    importSelected.mutate({
      name: packName.trim(),
      rules: selectedRules.map((r) => ({
        name: r.name,
        match: { op: r.op, conditions: r.conditions },
        actions: r.actions,
      })),
      origin: "ai",
    });
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-violet-500" /> AI 诊断 · 自动生成分拣规则
          </DialogTitle>
        </DialogHeader>

        {!result && (
          <div className="space-y-3">
            <p className="rounded-md bg-secondary/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              将拉取当前账号各文件夹近期邮件取样（总量上限可在「设置」页调整），由你配置的模型分析后给出规则建议。建议只读、不会自动生效，勾选确认后才会导入。
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>API-KEY</Label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                />
              </div>
              <div className="space-y-1.5">
                <Label>模型</Label>
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="如 kimi-k2.5" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>接口地址</Label>
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.moonshot.cn/v1" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>额外要求（可选）</Label>
                <Input
                  value={extraPrompt}
                  onChange={(e) => setExtraPrompt(e.target.value)}
                  placeholder="如：把工作邮件单独分类，账单加星标"
                />
              </div>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md bg-violet-500/10 px-3 py-2 text-xs text-violet-600 dark:text-violet-400">
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              模型建议 {result.rules.length} 条规则
              {result.skipped > 0 && `，另有 ${result.skipped} 条不合规被过滤`}
              。勾选需要的规则，确认包名后一键导入。
            </div>
            <div className="space-y-1.5">
              <Label>规则包名（导入后归入此分组）</Label>
              <Input value={packName} onChange={(e) => setPackName(e.target.value)} maxLength={80} />
            </div>
            <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
              {result.rules.map((r, i) => (
                <label
                  key={i}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2"
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
          </div>
        )}

        <DialogFooter className="mt-4">
          {result ? (
            <>
              <Button variant="outline" onClick={() => setResult(null)}>
                重新诊断
              </Button>
              <Button onClick={doImport} disabled={importSelected.isPending}>
                {importSelected.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                导入选中规则（{selectedRules.length} 条）
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>取消</Button>
              <Button onClick={run} disabled={diagnose.isPending}>
                {diagnose.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {diagnose.isPending ? "正在分析邮件…" : "开始诊断"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
