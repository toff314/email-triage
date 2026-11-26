import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { trpc } from "@/providers/trpc";

interface AccountCtx {
  accounts: { id: number; label: string; email: string }[];
  selectedId: number | null;
  setSelectedId: (id: number) => void;
  loading: boolean;
}

const Ctx = createContext<AccountCtx>({
  accounts: [],
  selectedId: null,
  setSelectedId: () => {},
  loading: true,
});

export function AccountProvider({ children }: { children: ReactNode }) {
  const list = trpc.account.list.useQuery();
  const [selectedId, setSelectedIdState] = useState<number | null>(() => {
    const raw = localStorage.getItem("triage.selectedAccount");
    return raw ? Number(raw) : null;
  });

  const accounts = useMemo(
    () =>
      (list.data ?? []).map((a) => ({ id: a.id, label: a.label, email: a.email })),
    [list.data],
  );

  // 选中的账号被删除（或列表刷新后不存在）时自动纠正：
  // 有备选就切到第一个，没有就置空；同步清掉本地记录，防止刷新后又复活旧 id。
  // 必须等列表加载完再判断，否则加载中的空列表会把任何选中都当成「已删除」。
  const loaded = list.data !== undefined;
  useEffect(() => {
    if (!loaded) return;
    if (selectedId && accounts.some((a) => a.id === selectedId)) return;
    const next = accounts[0]?.id ?? null;
    setSelectedIdState(next);
    if (next === null) localStorage.removeItem("triage.selectedAccount");
    else localStorage.setItem("triage.selectedAccount", String(next));
  }, [accounts, selectedId, loaded]);

  const setSelectedId = (id: number) => {
    localStorage.setItem("triage.selectedAccount", String(id));
    setSelectedIdState(id);
  };

  return (
    <Ctx.Provider
      value={{ accounts, selectedId, setSelectedId, loading: list.isLoading }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAccounts() {
  return useContext(Ctx);
}
