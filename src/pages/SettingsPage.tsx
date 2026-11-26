import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

interface NumField {
  key: "listLimit" | "runLimit" | "aiPerFolder" | "aiTotal";
  label: string;
  hint: string;
  min: number;
  max: number;
}

const NUM_FIELDS: NumField[] = [
  { key: "listLimit", label: "列表每页显示", hint: "收件箱等文件夹一次拉取多少封（默认 50，最多 200）", min: 10, max: 200 },
  { key: "runLimit", label: "执行分拣扫描", hint: "点「执行分拣」时扫描该文件夹最近多少封（默认 100，最多 500）", min: 10, max: 500 },
  { key: "aiPerFolder", label: "AI 诊断每文件夹取样", hint: "每个文件夹参与分析的最近邮件数（默认 15，最多 50）", min: 5, max: 50 },
  { key: "aiTotal", label: "AI 诊断总取样", hint: "所有文件夹合计上限，越多分析越全、耗时越长（默认 120，最多 500）", min: 20, max: 500 },
];

export default function SettingsPage() {
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery();
  const [nums, setNums] = useState<Record<string, string>>({});
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiKey, setAiKey] = useState("");
  const [collectContacts, setCollectContacts] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setNums({
      listLimit: String(settings.data.listLimit),
      runLimit: String(settings.data.runLimit),
      aiPerFolder: String(settings.data.aiPerFolder),
      aiTotal: String(settings.data.aiTotal),
    });
    setAiBaseUrl(settings.data.aiBaseUrl || "https://api.moonshot.cn/v1");
    setAiModel(settings.data.aiModel);
    setAiKey(settings.data.aiKey);
    setCollectContacts(settings.data.collectContacts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.dataUpdatedAt]);

  const save = trpc.settings.set.useMutation({
    onSuccess: async () => {
      toast.success("设置已保存");
      await utils.settings.get.invalidate();
      // 扫描范围变化后刷新邮件相关缓存
      await utils.mail.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const onSave = () => {
    const payload: Record<string, number | string | boolean> = {};
    for (const f of NUM_FIELDS) {
      const n = Number(nums[f.key]);
      if (!Number.isInteger(n) || n < f.min || n > f.max) {
        return toast.error(`「${f.label}」请输入 ${f.min}–${f.max} 之间的整数`);
      }
      payload[f.key] = n;
    }
    payload.aiBaseUrl = aiBaseUrl.trim();
    payload.aiModel = aiModel.trim();
    payload.aiKey = aiKey.trim();
    payload.collectContacts = collectContacts;
    save.mutate(payload as never);
  };

  return (
    <div className="mx-auto max-w-2xl overflow-y-auto p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">设置</h1>
        <p className="text-sm text-muted-foreground">
          扫描范围与 AI 模型配置全账号通用，保存后立即生效
        </p>
      </div>

      {settings.isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}

      <div className="space-y-6">
        <section className="space-y-3 rounded-md border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">扫描范围</h2>
          <div className="grid grid-cols-2 gap-3">
            {NUM_FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label>{f.label}</Label>
                <Input
                  type="number"
                  min={f.min}
                  max={f.max}
                  value={nums[f.key] ?? ""}
                  onChange={(e) => setNums({ ...nums, [f.key]: e.target.value })}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">{f.hint}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3 rounded-md border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">AI 模型</h2>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>接口地址</Label>
              <Input value={aiBaseUrl} onChange={(e) => setAiBaseUrl(e.target.value)} placeholder="https://api.moonshot.cn/v1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>模型</Label>
                <Input value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="如 kimi-k2.5 / deepseek-flash" />
              </div>
              <div className="space-y-1.5">
                <Label>API-KEY</Label>
                <Input type="password" value={aiKey} onChange={(e) => setAiKey(e.target.value)} placeholder="sk-..." />
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              KEY 加密存储，仅本人可见；留空表示清除已保存的 KEY
            </p>
          </div>
        </section>

        <section className="space-y-3 rounded-md border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">隐私</h2>
          <label className="flex items-start justify-between gap-3">
            <span>
              <span className="block text-sm">自动记录联系人</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                浏览或发送邮件时记录往来地址，用于写信时自动补全。默认关闭，不记录任何东西。
              </span>
            </span>
            <Switch checked={collectContacts} onCheckedChange={setCollectContacts} className="mt-0.5" />
          </label>
        </section>

        <div className="flex justify-end">
          <Button onClick={onSave} disabled={save.isPending}>
            {save.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            <Save className="mr-1 h-4 w-4" /> 保存设置
          </Button>
        </div>
      </div>
    </div>
  );
}
