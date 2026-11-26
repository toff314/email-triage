import { useState } from "react";
import { CheckCircle2, Pencil, Plus, Trash2, XCircle } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { MAIL_SERVER_PRESETS } from "@contracts/constants";

const PRESET_HOSTS = new Set(
  Object.values(MAIL_SERVER_PRESETS).flatMap((p) => [p.imap, p.smtp]),
);

interface Draft {
  id: number | null;
  label: string;
  email: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  authUser: string;
  domain: string;
  password: string;
}

const empty = (): Draft => ({
  id: null,
  label: "",
  email: "",
  imapHost: "",
  imapPort: "993",
  imapSecure: true,
  smtpHost: "",
  smtpPort: "465",
  smtpSecure: true,
  authUser: "",
  domain: "",
  password: "",
});

export default function AccountsPage() {
  const utils = trpc.useUtils();
  const list = trpc.account.list.useQuery();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<{ id: number; label: string } | null>(null);
  const [cleanupFolders, setCleanupFolders] = useState(true);
  const remove = trpc.account.remove.useMutation({
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.removedFolders.length > 0) parts.push(`已清理 ${r.removedFolders.length} 个自建文件夹`);
      if (r.restored > 0) parts.push(`${r.restored} 封邮件移回收件箱`);
      if (r.failedFolders.length > 0) parts.push(`${r.failedFolders.length} 个目录删除失败（${r.failedFolders.join("、")}）`);
      toast.success(parts.length > 0 ? `已删除：${parts.join("，")}` : "已删除");
      setRemoving(null);
      utils.account.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="mx-auto max-w-2xl overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">邮箱账号</h1>
          <p className="text-sm text-muted-foreground">
            通过 IMAP 读取、分拣邮件；凭据加密存储，服务器端连接
          </p>
        </div>
        <Button onClick={() => setEditing(empty())}>
          <Plus className="mr-1 h-4 w-4" /> 添加账号
        </Button>
      </div>

      <div className="space-y-2">
        {(list.data ?? []).map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3">
            {a.status === "ok" ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
            ) : a.status === "syncing" ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-amber-500" />
            ) : (
              <XCircle className="h-4 w-4 shrink-0 text-destructive" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{a.label}</span>
                <Badge variant="secondary">{a.imapHost}:{a.imapPort}</Badge>
              </div>
              <p className="truncate text-xs text-muted-foreground">{a.email}</p>
              {a.statusMessage && <p className="mt-0.5 truncate text-xs text-destructive">{a.statusMessage}</p>}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setEditing({
                  id: a.id,
                  label: a.label,
                  email: a.email,
                  imapHost: a.imapHost,
                  imapPort: String(a.imapPort),
                  imapSecure: a.imapSecure,
                  smtpHost: a.smtpHost ?? "",
                  smtpPort: String(a.smtpPort),
                  smtpSecure: a.smtpSecure,
                  authUser: a.authUser,
                  domain: a.domain ?? "",
                  password: "",
                })
              }
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => {
                setCleanupFolders(true);
                setRemoving({ id: a.id, label: a.label });
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {!list.isLoading && (list.data ?? []).length === 0 && (
          <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            还没有账号。支持 Gmail、Outlook、QQ 邮箱等一切支持 IMAP 的邮箱。
          </p>
        )}
      </div>

      {editing && (
        <AccountEditor draft={editing} onClose={() => setEditing(null)} onSaved={() => {
          setEditing(null);
          utils.account.list.invalidate();
        }} />
      )}

      {/* 删除账号确认：可选同时清理服务器上的自建文件夹 */}
      <Dialog open={removing !== null} onOpenChange={(v) => !v && setRemoving(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除「{removing?.label}」</DialogTitle>
            <DialogDescription>
              将删除该账号的本地数据（规则、分拣日志、目录记录），且无法恢复。
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-primary"
              checked={cleanupFolders}
              onChange={(e) => setCleanupFolders(e.target.checked)}
            />
            <span>
              同时清理邮箱服务器上的自建文件夹
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                文件夹里的邮件先移回收件箱再删除；系统目录（收件箱、已发送、广告邮件等）不受影响。
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate({ id: removing.id, cleanupFolders })}
            >
              {remove.isPending ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AccountEditor({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(draft);
  const create = trpc.account.create.useMutation({ onSuccess: onSaved, onError: (e) => toast.error(e.message) });
  const update = trpc.account.update.useMutation({ onSuccess: onSaved, onError: (e) => toast.error(e.message) });
  const test = trpc.account.testDraft.useMutation({
    onSuccess: (r) => (r.ok ? toast.success("连接成功") : toast.error(`连接失败：${r.message}`)),
    onError: (e) => toast.error(e.message),
  });

  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });

  /** 填邮箱地址时按后缀自动带出 IMAP/SMTP 地址和用户名 */
  const onEmailChange = (v: string) => {
    const patch: Partial<Draft> = { email: v };
    const m = v.trim().match(/@([a-z0-9.-]+\.[a-z]{2,})$/i);
    if (m) {
      const preset = MAIL_SERVER_PRESETS[m[1].toLowerCase()];
      if (preset) {
        // 只覆盖还是预设值/空的字段，用户手改过的内容不动
        if (!d.imapHost || PRESET_HOSTS.has(d.imapHost)) patch.imapHost = preset.imap;
        if (!d.smtpHost || PRESET_HOSTS.has(d.smtpHost)) patch.smtpHost = preset.smtp;
        if (!d.authUser) patch.authUser = v.trim();
        if (!d.label) patch.label = v.trim().split("@")[0];
      }
    }
    set(patch);
  };

  const runTest = () => {
    if (!d.imapHost.trim() || !d.authUser.trim())
      return toast.error("请填写 IMAP 主机和用户名");
    if (d.id === null && !d.password) return toast.error("请填写密码/授权码");
    test.mutate({
      id: d.id ?? undefined,
      imapHost: d.imapHost.trim(),
      imapPort: Number(d.imapPort) || 993,
      imapSecure: d.imapSecure,
      authUser: d.authUser.trim(),
      domain: d.domain.trim() || undefined,
      password: d.password || undefined,
    });
  };

  const payload = () => ({
    label: d.label.trim(),
    email: d.email.trim(),
    imapHost: d.imapHost.trim(),
    imapPort: Number(d.imapPort) || 993,
    imapSecure: d.imapSecure,
    smtpHost: d.smtpHost.trim() || undefined,
    smtpPort: Number(d.smtpPort) || 465,
    smtpSecure: d.smtpSecure,
    authUser: d.authUser.trim(),
    domain: d.domain.trim() || undefined,
    ...(d.password ? { password: d.password } : {}),
  });

  const save = () => {
    if (!d.label.trim() || !d.email.trim() || !d.imapHost.trim() || !d.authUser.trim())
      return toast.error("请填写完整：名称、邮箱、IMAP 主机、用户名");
    if (d.id === null && !d.password) return toast.error("请填写密码/授权码");
    const p = payload();
    if (d.id === null) create.mutate(p as never);
    else update.mutate({ id: d.id, ...p } as never);
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{d.id === null ? "添加邮箱账号" : "编辑账号"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>名称</Label>
              <Input value={d.label} onChange={(e) => set({ label: e.target.value })} placeholder="工作邮箱" />
            </div>
            <div className="space-y-1.5">
              <Label>邮箱地址</Label>
              <Input type="email" value={d.email} onChange={(e) => onEmailChange(e.target.value)} placeholder="me@example.com" />
            </div>
          </div>

          <div className="rounded-md border border-border p-3">
            <p className="mb-2 text-sm font-medium">IMAP（收信/分拣）</p>
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <Input value={d.imapHost} onChange={(e) => set({ imapHost: e.target.value })} placeholder="imap.example.com" />
              <Input value={d.imapPort} onChange={(e) => set({ imapPort: e.target.value })} placeholder="993" />
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={d.imapSecure} onCheckedChange={(v) => set({ imapSecure: v })} />
              SSL/TLS 加密连接
            </label>
          </div>

          <div className="rounded-md border border-border p-3">
            <p className="mb-2 text-sm font-medium">SMTP（发信，可选）</p>
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <Input value={d.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} placeholder="smtp.example.com" />
              <Input value={d.smtpPort} onChange={(e) => set({ smtpPort: e.target.value })} placeholder="465" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>用户名</Label>
              <Input value={d.authUser} onChange={(e) => set({ authUser: e.target.value })} placeholder="通常为完整邮箱地址" />
            </div>
            <div className="space-y-1.5">
              <Label>{d.id === null ? "密码 / 授权码" : "更新密码（留空不变）"}</Label>
              <Input type="password" value={d.password} onChange={(e) => set({ password: e.target.value })} placeholder="••••••••" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>域（Exchange 企业邮箱必填）</Label>
              <Input value={d.domain} onChange={(e) => set({ domain: e.target.value })} placeholder="如 QIANXIN；填了用 域\用户名 登录，普通邮箱留空" />
              <p className="text-xs text-muted-foreground">
                163/QQ/Gmail 等个人邮箱不用填；企业 Exchange 邮箱由管理员提供域名
              </p>
            </div>
          </div>
        </div>
        <DialogFooter className="mt-4 gap-2 sm:justify-between">
          <Button
            variant="outline"
            disabled={test.isPending}
            onClick={runTest}
          >
            {test.isPending ? "正在测试…" : "测试连接"}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={save} disabled={create.isPending || update.isPending}>保存</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
