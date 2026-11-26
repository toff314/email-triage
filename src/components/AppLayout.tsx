import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { Inbox, ListChecks, Settings2, LogOut, Mail, Settings } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useAccounts } from "@/lib/accounts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Toaster } from "@/components/ui/sonner";
import { AuthLayoutSkeleton } from "@/components/AuthLayoutSkeleton";

const navItems = [
  { to: "/", label: "收件", icon: Inbox },
  { to: "/rules", label: "分拣规则", icon: ListChecks },
  { to: "/accounts", label: "账号", icon: Settings2 },
  { to: "/settings", label: "设置", icon: Settings },
];

export default function AppLayout() {
  const me = trpc.auth.me.useQuery(undefined, { retry: false });
  const logout = trpc.auth.logout.useMutation();
  const navigate = useNavigate();
  const { accounts, selectedId, setSelectedId } = useAccounts();

  const unauthenticated = me.error?.data?.code === "UNAUTHORIZED";
  useEffect(() => {
    if (unauthenticated) navigate("/login", { replace: true });
  }, [unauthenticated, navigate]);

  if (!me.data) return <AuthLayoutSkeleton />;
  const initials = (me.data.name ?? me.data.email ?? "我").slice(0, 1);

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-52 flex-col border-r border-sidebar-border bg-sidebar-background">
        <div className="flex items-center gap-2 px-4 py-4">
          <Mail className="h-5 w-5 text-primary" />
          <span className="text-[15px] font-semibold tracking-wide">邮件分拣</span>
        </div>
        <nav className="flex-1 space-y-1 px-2">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-sm"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60"
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <Select
            value={selectedId ? String(selectedId) : ""}
            onValueChange={(v) => setSelectedId(Number(v))}
          >
            <SelectTrigger className="w-full bg-background">
              <SelectValue placeholder="选择邮箱账号" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  <span className="block max-w-36 truncate">{a.label}</span>
                  <span className="block max-w-36 truncate text-xs text-muted-foreground">
                    {a.email}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="mt-3 flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <Avatar className="h-7 w-7">
                <AvatarFallback className="bg-primary text-xs text-primary-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="max-w-20 truncate text-xs text-muted-foreground">
                {me.data?.name ?? ""}
              </span>
            </div>
            <button
              className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              title="退出登录"
              onClick={async () => {
                await logout.mutateAsync();
                navigate("/login");
              }}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      <Toaster position="bottom-right" />
    </div>
  );
}
