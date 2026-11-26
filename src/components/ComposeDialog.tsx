import { useMemo, useRef, useState } from "react";
import { Send, X } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";

/** 写信对话框：收件人支持通讯录补全，按域名后缀分组 */
export default function ComposeDialog({
  accountId,
  defaultTo,
  onClose,
}: {
  accountId: number;
  defaultTo?: string;
  onClose: () => void;
}) {
  const [to, setTo] = useState(defaultTo ?? "");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [pickerFor, setPickerFor] = useState<"to" | "cc" | null>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const ccRef = useRef<HTMLInputElement>(null);

  const contactsQuery = trpc.contact.list.useQuery(undefined, {
    staleTime: 30_000,
  });
  const send = trpc.mail.send.useMutation({
    onSuccess: () => {
      toast.success("已发送");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const contacts = useMemo(() => contactsQuery.data ?? [], [contactsQuery.data]);

  /** 按域名分组的候选：匹配输入的最后一个片段 */
  const suggestions = useMemo(() => {
    const source = pickerFor === "cc" ? cc : to;
    const tail = source.split(/[,，;；\s]+/).pop()?.trim().toLowerCase() ?? "";
    if (!tail) return [];
    const hit = contacts.filter(
      (c) => c.email.includes(tail) || c.name.toLowerCase().includes(tail),
    );
    const groups = new Map<string, typeof hit>();
    for (const c of hit) {
      const domain = c.email.split("@")[1] ?? "";
      const arr = groups.get(domain) ?? [];
      arr.push(c);
      groups.set(domain, arr);
    }
    return [...groups.entries()].slice(0, 6);
  }, [pickerFor, to, cc, contacts]);

  const appendAddress = (email: string) => {
    if (pickerFor === "cc") {
      const parts = cc.split(/[,，;；\s]+/).filter(Boolean);
      parts[parts.length - 1] = email;
      setCc(parts.join(", ") + ", ");
      ccRef.current?.focus();
    } else {
      const parts = to.split(/[,，;；\s]+/).filter(Boolean);
      parts[parts.length - 1] = email;
      setTo(parts.join(", ") + ", ");
      toRef.current?.focus();
    }
  };

  const doSend = () => {
    if (!to.trim()) return toast.error("请填写收件人");
    if (!subject.trim()) return toast.error("请填写主题");
    if (!text.trim()) return toast.error("请填写正文");
    send.mutate({ accountId, to: to.trim(), cc: cc.trim() || undefined, subject: subject.trim(), text: text.trim() });
  };

  const showPicker = (pickerFor === "to" || pickerFor === "cc") && suggestions.length > 0;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>写邮件</DialogTitle>
          <DialogDescription>从 {contacts.length} 位联系人中选择，或手动输入地址</DialogDescription>
        </DialogHeader>

        <div className="relative space-y-3">
          <div className="flex items-center gap-2">
            <Label className="w-14 shrink-0">收件人</Label>
            <Input
              ref={toRef}
              value={to}
              placeholder="name@example.com，多个用逗号分隔"
              onChange={(e) => {
                setTo(e.target.value);
                setPickerFor("to");
              }}
              onFocus={() => setPickerFor("to")}
              onBlur={() => setTimeout(() => setPickerFor(null), 200)}
            />
          </div>
          {showCc ? (
            <div className="flex items-center gap-2">
              <Label className="w-14 shrink-0">抄送</Label>
              <Input
                ref={ccRef}
                value={cc}
                placeholder="可留空"
                onChange={(e) => {
                  setCc(e.target.value);
                  setPickerFor("cc");
                }}
                onFocus={() => setPickerFor("cc")}
                onBlur={() => setTimeout(() => setPickerFor(null), 200)}
              />
            </div>
          ) : (
            <button
              className="ml-16 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowCc(true)}
            >
              + 添加抄送
            </button>
          )}
          <div className="flex items-center gap-2">
            <Label className="w-14 shrink-0">主题</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>

          {showPicker && (
            <div className="absolute left-16 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
              {suggestions.map(([domain, list]) => (
                <div key={domain}>
                  <p className="bg-secondary/60 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                    {domain}
                  </p>
                  {list.map((c) => (
                    <button
                      key={c.id}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-accent"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        appendAddress(c.email);
                      }}
                    >
                      <span>{c.name || c.email}</span>
                      <span className="text-xs text-muted-foreground">{c.email}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <textarea
          className="min-h-[240px] flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring"
          placeholder="正文…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            <X className="mr-1 h-4 w-4" /> 取消
          </Button>
          <Button onClick={doSend} disabled={send.isPending}>
            <Send className="mr-1 h-4 w-4" /> {send.isPending ? "发送中…" : "发送"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
