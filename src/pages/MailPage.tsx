import { useEffect, useState } from "react";
import {
  Archive,
  Folder,
  FolderInput,
  FolderPlus,
  Inbox,
  MailOpen,
  Mail,
  Pencil,
  Play,
  RotateCcw,
  Send,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import { trpc } from "@/providers/trpc";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAccounts } from "@/lib/accounts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import ComposeDialog from "@/components/ComposeDialog";
import RunPreviewDialog from "@/components/RunPreviewDialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

function fmtDate(d: Date | string) {
  const date = new Date(d);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 星标虚拟文件夹 key：跨文件夹聚合 \Flagged 邮件 */
const STARRED_KEY = "__starred__";

/** 系统/服务商内置目录：不提供管理入口（与服务端保护名单对齐，中英文都收） */
const LOCKED_FOLDERS = new Set([
  "inbox", "sent", "sent items", "drafts", "trash", "deleted items", "junk", "archive", "notes",
  "已发送", "已删除", "草稿", "草稿箱", "垃圾邮件", "垃圾箱", "垃圾", "存档", "发件箱",
  "广告邮件", "订阅邮件", "客户端删信",
].map((s) => s.toLowerCase()));

interface RunResult {
  scanned: number;
  matched: number;
  moved: number;
  flagged: number;
  deleted: number;
  errors: string[];
  perRule: { ruleId: string; name: string; hits: number }[];
}

export default function MailPage() {
  const { selectedId, accounts } = useAccounts();
  const [folder, setFolder] = useState("INBOX");
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<RunResult | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<string | undefined>(undefined);
  const [folderDialog, setFolderDialog] = useState<
    | { kind: "create" }
    | { kind: "rename"; path: string }
    | { kind: "remove"; path: string }
    | null
  >(null);
  const [folderName, setFolderName] = useState("");

  const rulesQuery = trpc.rule.list.useQuery();
  const folderCreate = trpc.mail.folderCreate.useMutation({
    onSuccess: () => {
      toast.success("文件夹已创建");
      setFolderDialog(null);
      setFolderName("");
      void utils.mail.folders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const folderRename = trpc.mail.folderRename.useMutation({
    onSuccess: (r, vars) => {
      toast.success(r.updatedRules > 0 ? `已重命名，并同步更新 ${r.updatedRules} 条规则` : "已重命名");
      if (folder === vars.from) setFolder(r.name);
      setFolderDialog(null);
      setFolderName("");
      void utils.mail.folders.invalidate();
      void utils.mail.folderStatus.invalidate();
      void utils.rule.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const folderRemove = trpc.mail.folderRemove.useMutation({
    onSuccess: (r, vars) => {
      if (!r.deleted) {
        toast.error("删除失败：文件夹可能不是空的，或服务器拒绝删除");
      } else {
        toast.success(
          r.moved > 0
            ? `已删除，${r.moved} 封邮件移回收件箱`
            : "已删除",
        );
      }
      if (r.referencedRules.length > 0) {
        toast.warning(`这些规则的目标文件夹已不存在：${r.referencedRules.join("、")}`);
      }
      if (folder === vars.name) setFolder("INBOX");
      setFolderDialog(null);
      void utils.mail.folders.invalidate();
      void utils.mail.folderStatus.invalidate();
      void utils.mail.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  /** 指向某物理文件夹的规则名（规则存逻辑名，压平后比对） */
  const folderRuleNames = (path: string) => {
    const flat = path.replace(/\//g, "-");
    return (rulesQuery.data ?? [])
      .filter((r) =>
        (r.actionsJson as { type: string; folder?: string }[]).some(
          (a) => a.type === "move" && a.folder && a.folder.replace(/\//g, "-") === flat,
        ),
      )
      .map((r) => r.name);
  };

  const utils = trpc.useUtils();
  const isStarred = folder === STARRED_KEY;

  const foldersQuery = trpc.mail.folders.useQuery(
    { accountId: selectedId! },
    { enabled: !!selectedId },
  );
  // 未读数：轮询兜底 + SSE/分拣后主动刷新
  const statusQuery = trpc.mail.folderStatus.useQuery(
    { accountId: selectedId! },
    { enabled: !!selectedId, refetchInterval: 60_000 },
  );
  const settingsQuery = trpc.settings.get.useQuery();
  const listLimit = settingsQuery.data?.listLimit ?? 50;
  const listQuery = trpc.mail.list.useQuery(
    { accountId: selectedId!, folder, limit: listLimit },
    { enabled: !!selectedId && !isStarred },
  );
  const starredQuery = trpc.mail.starred.useQuery(
    { accountId: selectedId! },
    { enabled: !!selectedId && isStarred },
  );
  const messages = isStarred ? (starredQuery.data ?? []) : (listQuery.data ?? []);
  const selectedMsg = messages.find((m) => m.uid === selectedUid);
  // 星标视图里邮件来自不同文件夹，读取/操作要用邮件自身的 folder
  const activeFolder = selectedMsg?.folder ?? folder;
  const messageQuery = trpc.mail.message.useQuery(
    { accountId: selectedId!, folder: activeFolder, uid: selectedUid! },
    { enabled: !!selectedId && selectedUid !== null },
  );

  // 切换账号时收件箱视图整体归位：旧账号的文件夹、选中信、勾选和各种弹窗都不带过来
  useEffect(() => {
    setFolder("INBOX");
    setSelectedUid(null);
    setChecked(new Set());
    setResult(null);
    setMoveOpen(false);
    setPreviewOpen(false);
    setComposeOpen(false);
    setReplyTo(undefined);
  }, [selectedId]);

  useEffect(() => {
    setSelectedUid(null);
    setChecked(new Set());
  }, [folder, selectedId]);

  // 实时推送：服务端 IMAP IDLE 监听新邮件，经 SSE 推送到这里
  useEffect(() => {
    if (!selectedId) return;
    const es = new EventSource(`/api/mail/events?accountId=${selectedId}`);
    // 断线重连成功后立刻拉一次数据兜底：代理切断长连接期间可能错过事件
    es.onopen = () => {
      void utils.mail.list.invalidate();
      void utils.mail.folders.invalidate();
      void utils.mail.folderStatus.invalidate();
    };
    es.onmessage = (e) => {
      let evt: {
        type: string;
        messages?: { subject?: string; fromAddr?: string }[];
        matched?: number;
        message?: string;
      };
      try {
        evt = JSON.parse(e.data);
      } catch {
        return;
      }
      if (evt.type === "ping") {
        return;
      }
      if (evt.type === "mail") {
        const first = evt.messages?.[0];
        const n = evt.messages?.length ?? 0;
        toast.info(`收到 ${n} 封新邮件`, {
          description: first ? `${first.fromAddr} — ${first.subject}` : undefined,
        });
        void utils.mail.list.invalidate();
        void utils.mail.folders.invalidate();
        void utils.mail.folderStatus.invalidate();
      } else if (evt.type === "triage") {
        if ((evt.matched ?? 0) > 0) {
          toast.success(`自动分拣：${evt.matched} 封邮件已按规则处理`);
          void utils.mail.list.invalidate();
          void utils.mail.folders.invalidate();
          void utils.mail.folderStatus.invalidate();
        }
      } else if (evt.type === "error") {
        toast.error("邮箱实时监控断开", { description: evt.message });
      }
    };
    return () => es.close();
  }, [selectedId, utils]);

  const triage = trpc.mail.triage.useMutation({
    onSuccess: async (_d, vars) => {
      toast.success(
        { move: "已移动", copy: "已复制", read: "已标为已读", unread: "已标为未读", star: "已加星标", unstar: "已取消星标", delete: "已删除" }[vars.action],
      );
      setChecked(new Set());
      if (vars.action === "move" || vars.action === "delete") setSelectedUid(null);
      await utils.mail.list.invalidate();
      await utils.mail.starred.invalidate();
      await utils.mail.folders.invalidate();
      await utils.mail.folderStatus.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // 打开邮件时自动标为已读（静默，不弹提示）
  const autoRead = trpc.mail.triage.useMutation({
    onSuccess: async (_d, vars) => {
      // 乐观更新列表缓存：粗体立即变正常
      utils.mail.list.setData({ accountId: selectedId!, folder: vars.folder, limit: listLimit }, (old) =>
        old?.map((m) =>
          vars.uids.includes(m.uid)
            ? { ...m, seen: true, flags: [...new Set([...m.flags, "\\Seen"])] }
            : m,
        ),
      );
      await utils.mail.starred.invalidate();
      await utils.mail.folderStatus.invalidate();
    },
    onError: () => {
      /* 标已读失败不打断阅读 */
    },
  });

  const runRules = trpc.mail.runRules.useMutation({
    onSuccess: async (r) => {
      setPreviewOpen(false);
      setResult(r);
      await utils.mail.list.invalidate();
      await utils.mail.folders.invalidate();
      await utils.mail.folderStatus.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // 还原上次手动「执行分拣」的移动（测试规则时把邮件放回收件箱）
  const restoreLastRun = trpc.mail.restoreLastRun.useMutation({
    onSuccess: async (r) => {
      toast.success(`已还原 ${r.restored} 封邮件回原文件夹`, {
        description: r.skipped > 0 ? `${r.skipped} 封跳过：已被再次移动或删除` : undefined,
      });
      await utils.mail.list.invalidate();
      await utils.mail.starred.invalidate();
      await utils.mail.folders.invalidate();
      await utils.mail.folderStatus.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // 给自己发测试邮件（空收件箱时调试规则用）
  const sendTest = trpc.mail.sendTest.useMutation({
    onSuccess: async () => {
      toast.success("测试邮件已发送，几秒后收件箱会出现新邮件");
      await utils.mail.list.invalidate();
      await utils.mail.folderStatus.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const markAllRead = trpc.mail.markAllRead.useMutation({
    onSuccess: async (r) => {
      toast.success(`已将 ${r.marked} 封邮件标为已读`);
      await utils.mail.list.invalidate();
      await utils.mail.folderStatus.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // 打开中的邮件被规则移走/删除时给出友好提示并刷新列表
  useEffect(() => {
    const msg = messageQuery.error?.message ?? "";
    if (msg.includes("不存在") || msg.includes("已移动") || msg.includes("已删除")) {
      toast.info("该邮件刚被规则移动或删除");
      setSelectedUid(null);
      void utils.mail.list.invalidate();
      void utils.mail.folders.invalidate();
      void utils.mail.folderStatus.invalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageQuery.error]);

  if (!selectedId) {
    return (
      <EmptyState title="还没有邮箱账号" hint="先到「账号」页添加一个 IMAP 邮箱" />
    );
  }
  const account = accounts.find((a) => a.id === selectedId);

  const folders = foldersQuery.data ?? [];
  const targetUids = checked.size > 0 ? [...checked] : selectedUid !== null ? [selectedUid] : [];

  // 星标视图里邮件可能来自多个文件夹，按来源分组后逐组操作
  const uidsByFolder = (uids: number[]) => {
    const map = new Map<string, number[]>();
    for (const m of messages) {
      if (uids.includes(m.uid)) {
        const arr = map.get(m.folder) ?? [];
        arr.push(m.uid);
        map.set(m.folder, arr);
      }
    }
    return map;
  };

  const doTriage = (action: "read" | "unread" | "star" | "unstar" | "delete") => {
    if (targetUids.length === 0) return toast.info("先勾选或选中一封邮件");
    const groups = uidsByFolder(targetUids);
    if (groups.size === 0) return toast.info("先勾选或选中一封邮件");
    for (const [f, uids] of groups) {
      triage.mutate({ accountId: selectedId, folder: f, uids, action });
    }
  };

  return (
    <div className="flex h-full">
      {/* 文件夹 */}
      <div className="w-44 shrink-0 space-y-0.5 overflow-y-auto border-r border-border p-2">
        <p className="flex items-center justify-between px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
          <span className="truncate">{account?.label ?? "文件夹"}</span>
          <button
            className="rounded p-0.5 hover:bg-accent hover:text-accent-foreground"
            title="新建文件夹"
            onClick={() => {
              setFolderName("");
              setFolderDialog({ kind: "create" });
            }}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </p>
        {foldersQuery.isLoading &&
          Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        {foldersQuery.error && (
          <p className="px-2 py-3 text-xs leading-relaxed text-destructive">
            无法连接邮箱：{foldersQuery.error.message}
          </p>
        )}
        <button
          onClick={() => setFolder(STARRED_KEY)}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm",
            isStarred
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50",
          )}
        >
          <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
          <span>星标邮件</span>
        </button>
        {folders.map((f) => {
          const isSystem =
            !!f.specialUse ||
            LOCKED_FOLDERS.has(f.path.toLowerCase()) ||
            LOCKED_FOLDERS.has(f.name.toLowerCase());
          const manageable = !isSystem;
          return (
            <div key={f.path} className="group relative">
              <button
                onClick={() => setFolder(f.path)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm",
                  folder === f.path
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                {isSystem ? (
                  f.specialUse === "\\Sent" ? (
                    <MailOpen className="h-3.5 w-3.5 shrink-0" />
                  ) : f.specialUse === "\\Trash" ? (
                    <Trash2 className="h-3.5 w-3.5 shrink-0" />
                  ) : f.specialUse === "\\Archive" ? (
                    <Archive className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <Inbox className="h-3.5 w-3.5 shrink-0" />
                  )
                ) : (
                  /* 用户自建目录：彩色文件夹图标，与灰色系统目录区分 */
                  <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
                )}
                <span className="truncate">{f.name}</span>
                {(statusQuery.data?.[f.path]?.unseen ?? 0) > 0 && (
                  <span className="ml-auto rounded-full bg-primary/10 px-1.5 text-[11px] font-medium text-primary group-hover:hidden">
                    {statusQuery.data![f.path].unseen}
                  </span>
                )}
              </button>
              {manageable && (
                <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 gap-0.5 rounded bg-background/95 p-0.5 shadow-sm group-hover:flex">
                  <button
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    title="重命名"
                    onClick={() => {
                      setFolderName(f.name);
                      setFolderDialog({ kind: "rename", path: f.path });
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                    title="删除文件夹"
                    onClick={() => setFolderDialog({ kind: "remove", path: f.path })}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* 列表 + 工具栏 */}
      <div className="flex w-[340px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-1 border-b border-border p-2">
          <Button
            size="sm"
            onClick={() => {
              setReplyTo(undefined);
              setComposeOpen(true);
            }}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            写信
          </Button>
          <Button
            size="sm"
            onClick={() => setPreviewOpen(true)}
            disabled={runRules.isPending}
            title="先预览分拣效果，确认后再执行"
          >
            <Play className="mr-1 h-3.5 w-3.5" />
            {runRules.isPending ? "分拣中…" : "执行分拣"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => restoreLastRun.mutate({ accountId: selectedId })}
            disabled={restoreLastRun.isPending}
            title="把上次「执行分拣」移走的邮件还原回去（只认手动执行，删除的邮件不还原）"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => sendTest.mutate({ accountId: selectedId })}
            disabled={sendTest.isPending}
            title="给自己发一封测试邮件，方便调试分拣规则"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (isStarred) {
                // 星标视图跨文件夹：对当前可见邮件逐一标已读
                for (const m of messages.filter((x) => !x.seen)) {
                  autoRead.mutate({ accountId: selectedId, folder: m.folder, uids: [m.uid], action: "read" });
                }
                return;
              }
              markAllRead.mutate({ accountId: selectedId, folder });
            }}
            disabled={markAllRead.isPending}
            title="全部标为已读"
          >
            <MailOpen className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => doTriage("read")} title="标为已读">
            <MailOpen className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => doTriage("star")} title="加星标">
            <Star className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => doTriage("unstar")} title="取消星标">
            <StarOff className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMoveOpen(true)} title="移动到…">
            <FolderInput className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            onClick={() => doTriage("delete")}
            title="删除"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {listQuery.isLoading && (
            <div className="space-y-2 p-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          )}
          {listQuery.error && (
            <p className="p-4 text-sm text-destructive">{listQuery.error.message}</p>
          )}
          {!listQuery.isLoading && messages.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">这个文件夹是空的</p>
          )}
          {messages.map((m) => (
            <ContextMenu key={m.uid}>
              <ContextMenuTrigger asChild>
                <div
                  onClick={() => {
                    setSelectedUid(m.uid);
                    // 点开未读邮件 → 自动标已读，未读数和粗体同步更新
                    if (!m.seen && selectedId) {
                      autoRead.mutate({ accountId: selectedId, folder: m.folder, uids: [m.uid], action: "read" });
                    }
                  }}
                  onContextMenu={() => {
                    // 右键未勾选的邮件：操作对象重置为它自己；已勾选则对整组操作
                    if (!checked.has(m.uid)) {
                      setChecked(new Set([m.uid]));
                      setSelectedUid(m.uid);
                    }
                  }}
                  className={cn(
                    "cursor-pointer border-b border-border/60 px-3 py-2.5",
                    selectedUid === m.uid ? "bg-accent/60" : "hover:bg-accent/30",
                  )}
                >
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 shrink-0 accent-primary"
                  checked={checked.has(m.uid)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const next = new Set(checked);
                    if (e.target.checked) next.add(m.uid);
                    else next.delete(m.uid);
                    setChecked(next);
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        "truncate text-sm",
                        m.seen ? "text-muted-foreground" : "font-semibold",
                      )}
                    >
                      {m.fromName || m.fromAddr}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {fmtDate(m.date)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {m.starred && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                    <span
                      className={cn(
                        "truncate text-[13px]",
                        m.seen ? "text-muted-foreground" : "font-medium",
                      )}
                    >
                      {m.subject}
                    </span>
                  </div>
                </div>
              </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-44">
                <ContextMenuItem onSelect={() => doTriage(m.seen ? "unread" : "read")}>
                  {m.seen ? "标为未读" : "标为已读"}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => doTriage(m.starred ? "unstar" : "star")}>
                  {m.starred ? "取消星标" : "加星标"}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => setMoveOpen(true)}>移动到…</ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => {
                    setReplyTo(m.fromAddr);
                    setComposeOpen(true);
                  }}
                >
                  回复
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem className="text-destructive" onSelect={() => doTriage("delete")}>
                  删除
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      </div>

      {/* 阅读区 */}
      <div className="min-w-0 flex-1 overflow-y-auto bg-card">
        {!selectedMsg && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            选择一封邮件查看
          </div>
        )}
        {selectedMsg && (
          <div className="mx-auto max-w-3xl px-8 py-6">
            <h2 className="text-lg font-semibold">{selectedMsg.subject}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {selectedMsg.fromName || selectedMsg.fromAddr}
              </span>
              {selectedMsg.fromName && <span>&lt;{selectedMsg.fromAddr}&gt;</span>}
              <span>{new Date(selectedMsg.date).toLocaleString("zh-CN")}</span>
              {selectedMsg.hasAttach && <Badge variant="secondary">附件</Badge>}
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => {
                  setReplyTo(selectedMsg.fromAddr);
                  setComposeOpen(true);
                }}
              >
                <Pencil className="mr-1 h-3.5 w-3.5" /> 回复
              </Button>
            </div>
            <div className="my-4 border-t border-border" />
            {messageQuery.isLoading && <Skeleton className="h-48 w-full" />}
            {messageQuery.data && (
              <article className="prose-sm max-w-none text-[15px] leading-relaxed">
                {messageQuery.data.html ? (
                  <div dangerouslySetInnerHTML={{ __html: messageQuery.data.html }} />
                ) : (
                  <pre className="whitespace-pre-wrap font-sans">{messageQuery.data.text}</pre>
                )}
                {messageQuery.data.attachments.length > 0 && (
                  <div className="mt-6 space-y-1">
                    {messageQuery.data.attachments.map((a, i) => (
                      <div key={i} className="rounded border border-border px-3 py-2 text-sm">
                        {a.filename}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {a.contentType} · {Math.ceil(a.size / 1024)} KB
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            )}
          </div>
        )}
      </div>

      {/* 写信 */}
      {composeOpen && (
        <ComposeDialog accountId={selectedId} defaultTo={replyTo} onClose={() => setComposeOpen(false)} />
      )}

      {/* 文件夹管理：新建 / 重命名 / 删除 */}
      <Dialog
        open={folderDialog !== null}
        onOpenChange={(v) => {
          if (!v) {
            setFolderDialog(null);
            setFolderName("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {folderDialog?.kind === "create"
                ? "新建文件夹"
                : folderDialog?.kind === "rename"
                  ? `重命名「${folderDialog.path}」`
                  : `删除「${folderDialog?.path}」`}
            </DialogTitle>
            <DialogDescription>
              {folderDialog?.kind === "remove" && (
                <>
                  里面的邮件会先移回收件箱，再删除文件夹。
                  {folderDialog.path && folderRuleNames(folderDialog.path).length > 0 && (
                    <span className="mt-1 block text-amber-600 dark:text-amber-400">
                      有 {folderRuleNames(folderDialog.path).length} 条规则指向它：
                      {folderRuleNames(folderDialog.path).join("、")}，删除后这些规则的移动将失败。
                    </span>
                  )}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {folderDialog?.kind !== "remove" && (
            <div className="space-y-1.5">
              <Label>文件夹名</Label>
              <Input
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !selectedId || !folderName.trim()) return;
                  if (folderDialog.kind === "create") {
                    folderCreate.mutate({ accountId: selectedId, name: folderName.trim() });
                  } else {
                    folderRename.mutate({
                      accountId: selectedId,
                      from: folderDialog.path,
                      to: folderName.trim(),
                    });
                  }
                }}
                placeholder="如：账单"
                maxLength={100}
                autoFocus
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setFolderDialog(null);
                setFolderName("");
              }}
            >
              取消
            </Button>
            {folderDialog?.kind === "create" && (
              <Button
                disabled={!folderName.trim() || folderCreate.isPending}
                onClick={() =>
                  selectedId &&
                  folderCreate.mutate({ accountId: selectedId, name: folderName.trim() })
                }
              >
                新建
              </Button>
            )}
            {folderDialog?.kind === "rename" && (
              <Button
                disabled={!folderName.trim() || folderRename.isPending}
                onClick={() =>
                  selectedId &&
                  folderRename.mutate({
                    accountId: selectedId,
                    from: folderDialog.path,
                    to: folderName.trim(),
                  })
                }
              >
                {folderRename.isPending ? "重命名中…" : "重命名"}
              </Button>
            )}
            {folderDialog?.kind === "remove" && selectedId && (
              <Button
                variant="destructive"
                disabled={folderRemove.isPending}
                onClick={() =>
                  folderDialog.kind === "remove" &&
                  folderRemove.mutate({ accountId: selectedId, name: folderDialog.path })
                }
              >
                {folderRemove.isPending ? "删除中…" : "删除"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 分拣预览（dry-run，确认后才执行）。规则只对收件箱生效，预览固定扫收件箱 */}
      {previewOpen && selectedId && (
        <RunPreviewDialog
          accountId={selectedId}
          folder="INBOX"
          onClose={() => setPreviewOpen(false)}
          onConfirm={() =>
            runRules.mutate({ accountId: selectedId, folder: "INBOX" })
          }
        />
      )}

      {/* 移动到 */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>移动到文件夹</DialogTitle>
            <DialogDescription>
              {targetUids.length > 0 ? `将 ${targetUids.length} 封邮件移动到：` : "请先勾选邮件"}
            </DialogDescription>
          </DialogHeader>
          <Select onValueChange={(dest) => {
            if (targetUids.length === 0) return;
            for (const [f, uids] of uidsByFolder(targetUids)) {
              triage.mutate({ accountId: selectedId, folder: f, uids, action: "move", dest });
            }
            setMoveOpen(false);
          }}>
            <SelectTrigger>
              <SelectValue placeholder="选择目标文件夹" />
            </SelectTrigger>
            <SelectContent>
              {folders.map((f) => (
                <SelectItem key={f.path} value={f.path}>
                  {f.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </DialogContent>
      </Dialog>

      {/* 分拣结果 */}
      <Dialog open={!!result} onOpenChange={() => setResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>分拣完成</DialogTitle>
            <DialogDescription>
              扫描 {result?.scanned} 封，命中 {result?.matched} 封；移动 {result?.moved}，标记 {result?.flagged}，删除 {result?.deleted}
            </DialogDescription>
          </DialogHeader>
          {result && result.perRule.length > 0 && (
            <div className="space-y-1 text-sm">
              {result.perRule.map((r) => (
                <div key={r.ruleId} className="flex justify-between border-b border-border/60 py-1.5">
                  <span>{r.name}</span>
                  <Badge variant="secondary">{r.hits} 次</Badge>
                </div>
              ))}
            </div>
          )}
          {result && result.errors.length > 0 && (
            <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              {result.errors.slice(0, 5).map((e, i) => (
                <p key={i}>{e}</p>
              ))}
              {result.errors.length > 5 && <p>…共 {result.errors.length} 个错误</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <Mail className="h-10 w-10 opacity-30" />
      <p className="text-base font-medium text-foreground">{title}</p>
      <p className="text-sm">{hint}</p>
    </div>
  );
}
