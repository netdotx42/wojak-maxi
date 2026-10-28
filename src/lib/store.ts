import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Mode = "off" | "paper" | "live";

export type PaperPosition = {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  amountRaw: string;
  decimals: number;
  costSol: number;
  leader: string;
  openedAt: number;
  highMarkSol: number | null;
  markSol: number | null;
  markAt: number | null;
};

export type ActivityItem = {
  id: string;
  at: number;
  tone: "info" | "ok" | "warn" | "danger";
  title: string;
  detail: string;
  href?: string;
};

type Persisted = {
  watchWallet: string;
  allocationPct: number;
  copyPct: number;
  maxPositionSol: number;
  maxExposureSol: number;
  maxConcurrent: number;
  feeReserveSol: number;
  slippageBps: number;
  maxSignalAgeSec: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  dailyLossLimitSol: number;
  perWalletCapSol: number;
  mode: Mode;
  killed: boolean;
  paperAck: boolean;
  liveAck: boolean;
  follows: { address: string; since: number }[];
  positions: PaperPosition[];
  activity: ActivityItem[];
  handled: string[];
  realizedDay: string;
  realizedSol: number;
};

type Store = Persisted & {
  reservedSol: number;
  hydrated: boolean;
  patch: (partial: Partial<Persisted>) => void;
  setHydrated: (value: boolean) => void;
  setReserved: (value: number) => void;
};

export const PAYBOX_WALLET = "4KtX9Yz4ShYhwDCCAZHJ5xxysyybQfHedpTuToi24FS8";

const initial: Persisted = {
  watchWallet: PAYBOX_WALLET,
  allocationPct: 40,
  copyPct: 5,
  maxPositionSol: 0.2,
  maxExposureSol: 1,
  maxConcurrent: 3,
  feeReserveSol: 0.05,
  slippageBps: 300,
  maxSignalAgeSec: 45,
  stopLossPct: 15,
  takeProfitPct: 40,
  trailingStopPct: 12,
  dailyLossLimitSol: 0.3,
  perWalletCapSol: 0.4,
  mode: "off",
  killed: false,
  paperAck: false,
  liveAck: false,
  follows: [],
  positions: [],
  activity: [],
  handled: [],
  realizedDay: "",
  realizedSol: 0,
};

export const useTerminal = create<Store>()(
  persist(
    (set) => ({
      ...initial,
      reservedSol: 0,
      hydrated: false,
      patch: (partial) => set(partial),
      setHydrated: (hydrated) => set({ hydrated }),
      setReserved: (reservedSol) => set({ reservedSol }),
    }),
    {
      name: "wojakmaxi.v1",
      version: 2,
      skipHydration: true,
      migrate: (persisted) => {
        const state = { ...initial, ...(persisted as Partial<Persisted>) };
        if (!state.watchWallet.trim()) state.watchWallet = PAYBOX_WALLET;
        return state;
      },
      partialize: (state) => ({
        watchWallet: state.watchWallet,
        allocationPct: state.allocationPct,
        copyPct: state.copyPct,
        maxPositionSol: state.maxPositionSol,
        maxExposureSol: state.maxExposureSol,
        maxConcurrent: state.maxConcurrent,
        feeReserveSol: state.feeReserveSol,
        slippageBps: state.slippageBps,
        maxSignalAgeSec: state.maxSignalAgeSec,
        stopLossPct: state.stopLossPct,
        takeProfitPct: state.takeProfitPct,
        trailingStopPct: state.trailingStopPct,
        dailyLossLimitSol: state.dailyLossLimitSol,
        perWalletCapSol: state.perWalletCapSol,
        mode: state.mode,
        killed: state.killed,
        paperAck: state.paperAck,
        liveAck: state.liveAck,
        follows: state.follows,
        positions: state.positions,
        activity: state.activity,
        handled: state.handled,
        realizedDay: state.realizedDay,
        realizedSol: state.realizedSol,
      }),
    },
  ),
);

export function logActivity(item: Omit<ActivityItem, "id" | "at"> & { at?: number }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  useTerminal.setState((state) => ({
    activity: [{ ...item, id, at: item.at ?? Date.now() }, ...state.activity].slice(0, 80),
  }));
}

export function remember(signature: string) {
  useTerminal.setState((state) => {
    if (state.handled.includes(signature)) return state;
    return { handled: [signature, ...state.handled].slice(0, 400) };
  });
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function realizedToday() {
  const state = useTerminal.getState();
  return state.realizedDay === todayKey() ? state.realizedSol : 0;
}

export function addRealized(delta: number) {
  const day = todayKey();
  useTerminal.setState((state) => ({
    realizedDay: day,
    realizedSol: (state.realizedDay === day ? state.realizedSol : 0) + delta,
  }));
}
