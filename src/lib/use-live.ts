import { useEffect, useMemo, useState } from "react";
import { askMaxi } from "./agent.functions";
import { getBalances, getFeed, getSmartFlow, getTopTraders, previewBuy, previewSell, scanWallets, tokenBrief } from "./market.functions";
import { NETWORK_FEE_SOL, planCopy, isSolAddress } from "./risk";
import {
  addRealized,
  logActivity,
  PAYBOX_WALLET,
  realizedToday,
  remember,
  useTerminal,
  type PaperPosition,
} from "./store";

type Feed = Awaited<ReturnType<typeof getFeed>>;
type Brief = NonNullable<Awaited<ReturnType<typeof tokenBrief>>["token"]>;

const queue: { chain: Promise<void> } = { chain: Promise.resolve() };

function enqueue(task: () => Promise<void>) {
  queue.chain = queue.chain.then(task).catch((error) => {
    logActivity({
      tone: "danger",
      title: "Engine error",
      detail: error instanceof Error ? error.message : "Unknown engine error",
    });
  });
}

function rawToTokens(raw: string, decimals: number) {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  return Number(whole) + Number(frac) / Number(base);
}

function portion(cost: number, part: bigint, total: bigint) {
  if (total <= 0n) return 0;
  return (cost * Number(part)) / Number(total);
}

function openCostFor(leader: string) {
  const { positions } = useTerminal.getState();
  return {
    all: positions.reduce((sum, position) => sum + position.costSol, 0),
    wallet: positions.filter((position) => position.leader === leader).reduce((sum, p) => sum + p.costSol, 0),
    count: positions.length,
  };
}

async function handleBuy(input: {
  signature: string;
  wallet: string;
  mint: string;
  name: string;
  symbol: string;
  at: number;
  source: string;
}) {
  const state = useTerminal.getState();
  if (state.handled.includes(input.signature)) return;
  const followed = state.follows.find((row) => row.address === input.wallet);
  if (!followed) return;
  const ageSec = (Date.now() - input.at) / 1000;
  const maxAge = input.source.startsWith("RPC") ? Math.max(state.maxSignalAgeSec, 120) : state.maxSignalAgeSec;
  if (input.at < followed.since - 5000 || ageSec > maxAge) {
    remember(input.signature);
    logActivity({
      tone: "warn",
      title: "Stale buy skipped",
      detail: `${input.symbol || input.mint.slice(0, 4)} · ${Math.round(ageSec)}s old · ${input.source}`,
      href: `https://solscan.io/tx/${input.signature}`,
    });
    return;
  }
  if (state.killed) {
    remember(input.signature);
    logActivity({
      tone: "danger",
      title: "Buy halted",
      detail: "Emergency stop is on",
      href: `https://solscan.io/tx/${input.signature}`,
    });
    return;
  }
  if (state.mode === "off") return;
  if (state.mode === "live") {
    remember(input.signature);
    logActivity({
      tone: "danger",
      title: "Live buy blocked",
      detail: "No signing key is configured. Private keys are never accepted, so the order was not sent.",
      href: `https://solscan.io/tx/${input.signature}`,
    });
    return;
  }
  if (!state.paperAck) {
    remember(input.signature);
    logActivity({ tone: "warn", title: "Paper buy blocked", detail: "Paper trading is not authorized." });
    return;
  }
  if (isSolAddress(state.watchWallet) && latestBalance == null) return;
  const balance = state.watchWallet ? latestBalance : null;
  const exposure = openCostFor(input.wallet);
  const adding = state.positions.some((position) => position.mint === input.mint && position.leader === input.wallet);
  const plan = planCopy({
    balanceSol: balance ?? 0,
    allocationPct: state.allocationPct,
    copyPct: state.copyPct,
    feeReserveSol: state.feeReserveSol,
    maxPositionSol: state.maxPositionSol,
    maxExposureSol: state.maxExposureSol,
    openCostSol: exposure.all,
    reservedSol: useTerminal.getState().reservedSol,
    perWalletCapSol: state.perWalletCapSol,
    walletOpenSol: exposure.wallet,
    maxConcurrent: state.maxConcurrent,
    openCount: adding ? Math.max(0, exposure.count - 1) : exposure.count,
    dailyRealizedSol: realizedToday(),
    dailyLossLimitSol: state.dailyLossLimitSol,
  });
  if (plan.sizeSol <= 0) {
    remember(input.signature);
    logActivity({
      tone: "warn",
      title: "Buy skipped",
      detail: plan.blockers[0] || "Risk check failed",
      href: `https://solscan.io/tx/${input.signature}`,
    });
    return;
  }
  useTerminal.getState().setReserved(useTerminal.getState().reservedSol + plan.sizeSol);
  remember(input.signature);
  try {
    const evalResult = await previewBuy({
      data: {
        mint: input.mint,
        lamports: Math.floor(plan.sizeSol * 1e9),
        slippageBps: state.slippageBps,
      },
    });
    if (!evalResult.ok || !evalResult.quote || !evalResult.token) {
      const failed = evalResult.checks.filter((check) => !check.pass).map((check) => check.detail);
      logActivity({
        tone: "warn",
        title: "Buy rejected",
        detail: failed[0] || "Mandatory check failed",
        href: `https://pump.fun/coin/${input.mint}`,
      });
      return;
    }
    const decimals = evalResult.token.decimals;
    const boughtRaw = BigInt(evalResult.quote.outAmount);
    useTerminal.setState((current) => {
      const existing = current.positions.find(
        (position) => position.mint === input.mint && position.leader === input.wallet,
      );
      let positions: PaperPosition[];
      if (existing) {
        positions = current.positions.map((position) =>
          position.id === existing.id
            ? {
                ...position,
                amountRaw: (BigInt(position.amountRaw) + boughtRaw).toString(),
                costSol: position.costSol + plan.sizeSol,
                symbol: evalResult.token?.symbol || position.symbol,
                name: evalResult.token?.name || position.name,
              }
            : position,
        );
      } else {
        positions = [
          {
            id: `${input.signature.slice(0, 8)}-${input.mint.slice(0, 4)}`,
            mint: input.mint,
            symbol: evalResult.token?.symbol || input.symbol || "?",
            name: evalResult.token?.name || input.name || "Unknown",
            amountRaw: boughtRaw.toString(),
            decimals,
            costSol: plan.sizeSol,
            leader: input.wallet,
            openedAt: Date.now(),
            highMarkSol: null,
            markSol: null,
            markAt: null,
          },
          ...current.positions,
        ];
      }
      return { positions };
    });
    logActivity({
      tone: "ok",
      title: "Paper buy filled at quote",
      detail: `${plan.sizeSol} SOL → ${evalResult.token.symbol} · impact ${(evalResult.quote.priceImpactPct * 100).toFixed(2)}% · not an on-chain fill`,
      href: `https://solscan.io/tx/${input.signature}`,
    });
  } finally {
    useTerminal.getState().setReserved(Math.max(0, useTerminal.getState().reservedSol - plan.sizeSol));
  }
}

async function closeFraction(position: PaperPosition, fractionBps: number, reason: string) {
  const total = BigInt(position.amountRaw);
  const part = (total * BigInt(fractionBps)) / 10_000n;
  if (part <= 0n) return;
  const quote = await previewSell({
    data: {
      mint: position.mint,
      amountRaw: part.toString(),
      slippageBps: useTerminal.getState().slippageBps,
    },
  });
  if (!quote.ok || !quote.quote) {
    logActivity({
      tone: "warn",
      title: "Paper sell skipped",
      detail: quote.error || "No executable sell quote",
      href: `https://pump.fun/coin/${position.mint}`,
    });
    return;
  }
  const proceeds = Number(quote.quote.outAmount) / 1e9;
  const cost = portion(position.costSol, part, total);
  const pnl = proceeds - NETWORK_FEE_SOL - cost;
  addRealized(pnl);
  const left = total - part;
  useTerminal.setState((state) => ({
    positions:
      left <= 0n
        ? state.positions.filter((row) => row.id !== position.id)
        : state.positions.map((row) =>
            row.id === position.id
              ? {
                  ...row,
                  amountRaw: left.toString(),
                  costSol: Math.max(0, row.costSol - cost),
                  markSol: null,
                  markAt: null,
                }
              : row,
          ),
  }));
  logActivity({
    tone: pnl >= 0 ? "ok" : "danger",
    title: `Paper sell · ${reason}`,
    detail: `${position.symbol} proceeds ${proceeds.toFixed(4)} SOL · pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL · quote, not on-chain`,
    href: `https://pump.fun/coin/${position.mint}`,
  });
}

async function handleSell(input: {
  signature: string;
  wallet: string;
  mint: string;
  at: number;
  soldPct: number | null;
}) {
  const state = useTerminal.getState();
  if (state.handled.includes(input.signature)) return;
  remember(input.signature);
  const followed = state.follows.some((row) => row.address === input.wallet);
  if (!followed) return;
  logActivity({
    tone: "info",
    title: "Leader sell observed",
    detail: `${input.soldPct == null ? "size unverified" : `${Math.round(input.soldPct * 100)}% of their tracked balance`} · ${input.mint.slice(0, 4)}…`,
    href: `https://solscan.io/tx/${input.signature}`,
  });
  if (state.killed || state.mode !== "paper" || !state.paperAck) {
    if (state.mode === "live") {
      logActivity({
        tone: "danger",
        title: "Live sell blocked",
        detail: "Signing is disabled. The mirrored sell was not submitted.",
      });
    }
    return;
  }
  const ageSec = (Date.now() - input.at) / 1000;
  if (ageSec > state.maxSignalAgeSec) {
    logActivity({ tone: "warn", title: "Stale sell skipped", detail: `${Math.round(ageSec)}s old` });
    return;
  }
  const position = useTerminal
    .getState()
    .positions.find((row) => row.leader === input.wallet && row.mint === input.mint);
  if (!position) {
    logActivity({
      tone: "warn",
      title: "Sell mirror skipped",
      detail: "No paper position tracked for this leader and mint",
    });
    return;
  }
  const pct = input.soldPct == null ? 1 : Math.max(0, Math.min(1, input.soldPct));
  await closeFraction(position, Math.max(1, Math.round(pct * 10_000)), "leader mirror");
}

let scanWarnedAt = 0;
let latestBalance: number | null = null;
let marking = false;

async function markPositions() {
  const state = useTerminal.getState();
  if (marking || state.mode !== "paper" || state.killed || state.positions.length === 0) return;
  marking = true;
  try {
    const position = [...state.positions].sort((a, b) => (a.markAt ?? 0) - (b.markAt ?? 0))[0];
    if (!position) return;
    const quote = await previewSell({
      data: {
        mint: position.mint,
        amountRaw: position.amountRaw,
        slippageBps: state.slippageBps,
      },
    });
    if (!quote.ok || !quote.quote) return;
    const markSol = Number(quote.quote.outAmount) / 1e9;
    const high = Math.max(position.highMarkSol ?? markSol, markSol);
    useTerminal.setState((current) => ({
      positions: current.positions.map((row) =>
        row.id === position.id ? { ...row, markSol, markAt: Date.now(), highMarkSol: high } : row,
      ),
    }));
    const fresh = useTerminal.getState().positions.find((row) => row.id === position.id);
    if (!fresh || fresh.markAt == null || Date.now() - fresh.markAt > 20_000) return;
    const cost = fresh.costSol;
    if (!(cost > 0) || fresh.markSol == null) return;
    const settings = useTerminal.getState();
    if (fresh.markSol >= cost * (1 + settings.takeProfitPct / 100)) {
      await closeFraction(fresh, 10_000, "take-profit");
    } else if (fresh.markSol <= cost * (1 - settings.stopLossPct / 100)) {
      await closeFraction(fresh, 10_000, "stop-loss");
    } else if (
      fresh.highMarkSol != null &&
      fresh.highMarkSol > cost &&
      fresh.markSol <= fresh.highMarkSol * (1 - settings.trailingStopPct / 100)
    ) {
      await closeFraction(fresh, 10_000, "trailing stop");
    }
  } finally {
    marking = false;
  }
}

export function useLive() {
  const hydrated = useTerminal((s) => s.hydrated);
  const follows = useTerminal((s) => s.follows);
  const watchWallet = useTerminal((s) => s.watchWallet);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [balanceAt, setBalanceAt] = useState<number | null>(null);
  const [briefs, setBriefs] = useState<Record<string, Brief>>({});
  const [swaps, setSwaps] = useState<
    { signature: string; wallet: string; side: "buy" | "sell"; mint: string; sol: number; at: number }[]
  >([]);
  const [agentText, setAgentText] = useState<string>("");
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [leaders, setLeaders] = useState<Awaited<ReturnType<typeof getTopTraders>> | null>(null);
  const [leaderError, setLeaderError] = useState<string | null>(null);
  const [smart, setSmart] = useState<Awaited<ReturnType<typeof getSmartFlow>> | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await useTerminal.persist.rehydrate();
      if (!useTerminal.getState().watchWallet.trim()) {
        useTerminal.getState().patch({ watchWallet: PAYBOX_WALLET });
      }
      if (alive) useTerminal.getState().setHydrated(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    let stop = false;
    const pull = async () => {
      try {
        const snap = await getFeed();
        if (stop) return;
        setFeed(snap);
        setFeedError(null);
      } catch (error) {
        if (!stop) setFeedError(error instanceof Error ? error.message : "Feed failed");
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 5000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let stop = false;
    const pull = async () => {
      if (!isSolAddress(watchWallet)) {
        latestBalance = null;
        setBalanceSol(null);
        setBalanceError(watchWallet.trim() ? "Address is not a Solana public key" : null);
        setBalanceAt(null);
        return;
      }
      try {
        const result = await getBalances({ data: { addresses: [watchWallet] } });
        if (stop) return;
        const row = result.balances[0];
        if (!row || row.lamports == null) {
          latestBalance = null;
          setBalanceSol(null);
          setBalanceError(row?.error || "Balance unverified");
        } else {
          const sol = row.lamports / 1e9;
          latestBalance = sol;
          setBalanceSol(sol);
          setBalanceError(null);
        }
        setBalanceAt(result.fetchedAt);
      } catch (error) {
        if (!stop) setBalanceError(error instanceof Error ? error.message : "Balance failed");
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 15000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [hydrated, watchWallet]);

  useEffect(() => {
    if (!hydrated) return;
    let stop = false;
    const pull = async () => {
      try {
        const board = await getTopTraders();
        if (stop) return;
        setLeaders(board);
        setLeaderError(board.error);
        if (!board.traders.length) return;
        const state = useTerminal.getState();
        const next = board.traders.map((row) => row.address);
        const same =
          state.follows.length === next.length && state.follows.every((row, index) => row.address === next[index]);
        if (same) return;
        const since = new Map(state.follows.map((row) => [row.address, row.since]));
        state.patch({
          follows: next.map((address) => ({ address, since: since.get(address) ?? Date.now() })),
        });
        logActivity({
          tone: "info",
          title: "Watching the top 5",
          detail: next.map((address) => `${address.slice(0, 4)}…${address.slice(-4)}`).join(" · "),
        });
      } catch (error) {
        if (!stop) setLeaderError(error instanceof Error ? error.message : "Leaderboard failed");
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 45_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let stop = false;
    const pull = async () => {
      try {
        const flow = await getSmartFlow();
        if (!stop) setSmart(flow);
      } catch {
        /* keep the last board */
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 45_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated || follows.length === 0) return;
    let stop = false;
    const pull = async () => {
      try {
        const result = await scanWallets({
          data: { addresses: follows.slice(0, 5).map((row) => row.address) },
        });
        if (stop) return;
        if (result.signals.length) {
          setSwaps((current) => {
            const incoming = result.signals.map((signal) => ({
              signature: signal.signature,
              wallet: signal.wallet,
              side: signal.side,
              mint: signal.mint,
              sol: Math.abs(signal.solDelta),
              at: (signal.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
            }));
            const seen = new Set(current.map((row) => row.signature));
            return [...incoming.filter((row) => !seen.has(row.signature)), ...current].slice(0, 30);
          });
        }
        for (const signal of result.signals) {
          const settings = useTerminal.getState();
          if (settings.mode === "off" || settings.killed) continue;
          const at = (signal.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
          if (signal.side === "buy") {
            enqueue(() =>
              handleBuy({
                signature: signal.signature,
                wallet: signal.wallet,
                mint: signal.mint,
                name: "",
                symbol: "",
                at,
                source: "RPC balance delta",
              }),
            );
          } else {
            enqueue(() =>
              handleSell({
                signature: signal.signature,
                wallet: signal.wallet,
                mint: signal.mint,
                at,
                soldPct: signal.soldPct,
              }),
            );
          }
        }
      } catch (error) {
        if (Date.now() - scanWarnedAt > 60_000) {
          scanWarnedAt = Date.now();
          logActivity({
            tone: "danger",
            title: "Wallet scan failed",
            detail: error instanceof Error ? error.message : "RPC scan failed",
          });
        }
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 14000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [hydrated, follows]);

  useEffect(() => {
    if (!feed) return;
    for (const event of feed.events) {
      if (event.txType !== "create" && event.solAmount <= 0) continue;
      if (useTerminal.getState().handled.includes(event.signature)) continue;
      if (!useTerminal.getState().follows.some((row) => row.address === event.trader)) continue;
      const settings = useTerminal.getState();
      if (settings.mode === "off" || settings.killed) continue;
      enqueue(() =>
        handleBuy({
          signature: event.signature,
          wallet: event.trader,
          mint: event.mint,
          name: event.name,
          symbol: event.symbol,
          at: event.receivedAt,
          source: "PumpPortal create",
        }),
      );
    }
  }, [feed]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = setInterval(() => void markPositions(), 20000);
    return () => clearInterval(timer);
  }, [hydrated]);

  const whaleMints = useMemo(() => {
    const rows = (feed?.events || []).filter((event) => event.solAmount >= 0.5);
    return rows.map((event) => event.mint).filter((mint, index, all) => all.indexOf(mint) === index);
  }, [feed]);

  useEffect(() => {
    const mint = whaleMints.find((item) => !briefs[item]);
    if (!mint) return;
    let stop = false;
    void tokenBrief({ data: { mint } })
      .then((result) => {
        if (stop || !result.token) return;
        setBriefs((current) => ({ ...current, [mint]: result.token as Brief }));
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [whaleMints, briefs]);

  async function briefAgent(snapshot: string) {
    setAgentBusy(true);
    setAgentError(null);
    try {
      const result = await askMaxi({ data: { brief: snapshot } });
      if (!result.ok) setAgentError(result.error);
      else setAgentText(result.text);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Agent failed");
    } finally {
      setAgentBusy(false);
    }
  }

  return {
    feed,
    feedError,
    balanceSol,
    balanceError,
    balanceAt,
    briefs,
    swaps,
    agentText,
    agentError,
    agentBusy,
    briefAgent,
    leaders,
    leaderError,
    smart,
  };
}
