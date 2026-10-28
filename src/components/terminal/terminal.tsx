import { Octagon } from "lucide-react";
import logo from "@/assets/wojak-logo.jpg";
import { formatAge, formatSol, formatUsd, planCopy, shortAddr, solscanAccount, solscanTx } from "@/lib/risk";
import { logActivity, PAYBOX_WALLET, useTerminal, type Mode } from "@/lib/store";
import { useLive } from "@/lib/use-live";

export function Terminal() {
  const live = useLive();
  const store = useTerminal();
  const openCost = store.positions.reduce((sum, position) => sum + position.costSol, 0);
  const day = new Date().toISOString().slice(0, 10);
  const realized = store.realizedDay === day ? store.realizedSol : 0;
  const plan = planCopy({
    balanceSol: live.balanceSol ?? 0,
    allocationPct: store.allocationPct,
    copyPct: store.copyPct,
    feeReserveSol: store.feeReserveSol,
    maxPositionSol: store.maxPositionSol,
    maxExposureSol: store.maxExposureSol,
    openCostSol: openCost,
    reservedSol: store.reservedSol,
    perWalletCapSol: store.perWalletCapSol,
    walletOpenSol: 0,
    maxConcurrent: store.maxConcurrent,
    openCount: store.positions.length,
    dailyRealizedSol: realized,
    dailyLossLimitSol: store.dailyLossLimitSol,
  });
  const traders = live.leaders?.traders || [];
  const solUsd = live.feed?.health.solPriceUsd ?? null;
  const isPaybox = store.watchWallet === PAYBOX_WALLET;
  const auto = autoLine({
    killed: store.killed,
    mode: store.mode,
    balance: live.balanceSol,
    leaders: traders.length,
    size: plan.sizeSol,
    blocker: plan.blockers[0] || null,
  });

  function arm(mode: Mode) {
    if (store.killed) return;
    store.patch({ mode, paperAck: mode === "paper" ? true : store.paperAck });
    logActivity({
      tone: mode === "paper" ? "ok" : "info",
      title: mode === "paper" ? "Auto paper on" : "Auto off",
      detail:
        mode === "paper"
          ? "Fresh buys from the current top 5 are copied off-chain at a live quote."
          : "Copying paused. The top 5 are still listed.",
    });
  }

  function kill() {
    store.patch({ killed: true, mode: "off" });
    store.setReserved(0);
    logActivity({ tone: "danger", title: "Emergency stop", detail: "Auto copy is halted." });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="desk-head panel flex items-center gap-3 px-3 py-3">
        <img src={logo} alt="WOJAKMAXI" className="logo-frame h-14 w-14 sm:h-16 sm:w-16" />
        <div className="min-w-0">
          <p className="text-xs tracking-[0.22em] text-cyan">WOJAKMAXI</p>
          <h1 className="text-xl font-semibold leading-tight sm:text-2xl">Top 5 by PnL</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="text-right">
            <p className="text-xs text-muted">{isPaybox ? "Paybox" : "Wallet"}</p>
            <p className="num text-lg leading-none">{live.balanceSol == null ? "—" : `${formatSol(live.balanceSol)} SOL`}</p>
          </div>
          <button type="button" onClick={kill} className="inline-flex h-11 items-center gap-2 rounded-full bg-danger px-4 text-sm font-semibold text-bg">
            <Octagon className="h-4 w-4" />
            Stop
          </button>
        </div>
      </header>

      {store.killed && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-danger bg-danger/15 px-4 py-3 text-sm">
          <p>Kill switch is on. Auto copy will not run.</p>
          <button type="button" className="h-11 rounded-full border border-line px-4" onClick={() => store.patch({ killed: false })}>
            Release
          </button>
        </div>
      )}

      <section className="grid items-start gap-4 lg:grid-cols-[1.35fr_0.85fr]">
        <section className="panel overflow-hidden">
          <div className="flex items-end justify-between gap-3 px-5 py-4">
            <div>
              <h2 className="text-lg font-semibold">Current leaders</h2>
              <p className="text-sm text-muted">{live.leaders?.source || "Ranking wallets on hot Pump.fun tokens"}</p>
            </div>
            <p className="text-xs text-cyan">{traders.length ? "Only these 5 are scanned" : "Scanning"}</p>
          </div>
          {traders.length === 0 && (
            <p className="border-t border-line px-5 py-8 text-sm text-muted">
              {live.leaderError || "Pulling the current PnL board…"}
            </p>
          )}
          <ol>
            {traders.map((trader, index) => (
              <li key={trader.address} className="flex items-center gap-4 border-t border-line px-5 py-4">
                <span className="num w-8 text-3xl font-medium text-cyan">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <a className="num text-base" href={solscanAccount(trader.address)} target="_blank" rel="noreferrer">
                    {shortAddr(trader.address)}
                  </a>
                  <p className="text-xs text-muted">
                    {trader.trades} trades · {trader.tokens} hot {trader.tokens === 1 ? "token" : "tokens"}
                  </p>
                </div>
                <p className="num text-lg text-ok">+{formatUsd(trader.pnlUsd)}</p>
              </li>
            ))}
          </ol>
        </section>

        <aside className="grid gap-4">
          <section className="panel flex flex-col gap-4 p-5">
            <div>
              <p className="text-xs tracking-[0.16em] text-cyan">AUTO COPY</p>
              <p className="mt-2 text-base leading-relaxed">{auto}</p>
            </div>
            <p className="num rounded-2xl bg-bg/70 px-4 py-3 text-sm">
              Next copy <span className="text-cyan">{formatSol(plan.sizeSol)} SOL</span>
              <span className="block text-xs text-muted">
                {store.allocationPct}% allocated · {store.copyPct}% of that
                {solUsd && live.balanceSol != null ? ` · ${formatUsd(live.balanceSol * solUsd)}` : ""}
              </span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => arm("off")}
                className={`h-11 rounded-full text-sm font-semibold ${store.mode === "off" ? "bg-cyan text-bg" : "border border-line"}`}
              >
                Off
              </button>
              <button
                type="button"
                disabled={store.killed}
                onClick={() => arm("paper")}
                className={`h-11 rounded-full text-sm font-semibold disabled:opacity-40 ${store.mode === "paper" ? "bg-cyan text-bg" : "border border-line"}`}
              >
                Paper
              </button>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              Paper uses a live Jupiter quote and does not send a transaction. Live signing is not connected, so this desk cannot spend Paybox.
            </p>
            <p className="num break-all text-xs text-muted">{store.watchWallet}</p>
          </section>

          <section className="panel p-5">
            <h2 className="mb-3 text-sm font-semibold">Last actions</h2>
            <ul className="flex max-h-64 flex-col gap-3 overflow-auto">
              {store.activity.length === 0 && <li className="text-sm text-muted">Copies and skips show up here.</li>}
              {store.activity.slice(0, 8).map((item) => (
                <li key={item.id}>
                  <p className={item.tone === "danger" ? "text-sm text-danger" : item.tone === "ok" ? "text-sm text-ok" : item.tone === "warn" ? "text-sm text-warn" : "text-sm"}>
                    {item.title}
                  </p>
                  <p className="text-xs text-muted">{item.detail}</p>
                </li>
              ))}
            </ul>
            {store.positions.length > 0 && (
              <p className="mt-3 text-xs text-muted">{store.positions.length} open paper {store.positions.length === 1 ? "position" : "positions"} · realized {formatSol(realized)} SOL</p>
            )}
          </section>
        </aside>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <MoveBoard
          title="Axiom traders"
          hint="Live swaps that paid an Axiom fee wallet. Watched, not copied."
          rows={live.smart?.axiom || []}
          waiting={!live.smart}
        />
        <MoveBoard
          title="FOMO traders"
          hint="24h fomo.family leaders, then their latest chain swap."
          rows={live.smart?.fomo || []}
          waiting={!live.smart}
        />
      </section>
    </main>
  );
}

function MoveBoard({
  title,
  hint,
  rows,
  waiting,
}: {
  title: string;
  hint: string;
  rows: NonNullable<ReturnType<typeof useLive>["smart"]>["axiom"];
  waiting: boolean;
}) {
  return (
    <section className="panel overflow-hidden">
      <div className="px-5 py-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted">{hint}</p>
      </div>
      {rows.length === 0 && (
        <p className="border-t border-line px-5 py-6 text-sm text-muted">{waiting ? "Scanning…" : "No classified swap in this pass."}</p>
      )}
      <ul>
        {rows.map((row) => (
          <li key={`${row.venue}-${row.wallet}-${row.signature || "none"}`} className="flex items-center gap-3 border-t border-line px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{row.label || shortAddr(row.wallet)}</p>
              <p className="num text-xs text-muted">
                {row.label ? `${shortAddr(row.wallet)} · ` : ""}
                {row.side ? row.side.toUpperCase() : "no fresh swap"}
                {row.mint ? ` · ${shortAddr(row.mint)}` : ""}
                {row.at ? ` · ${formatAge(Date.now() - row.at)}` : ""}
              </p>
            </div>
            <div className="text-right">
              {row.pnlUsd != null && <p className="num text-sm text-ok">+{formatUsd(row.pnlUsd)}</p>}
              {row.sol != null && <p className="num text-xs text-cyan">{formatSol(row.sol, 3)} SOL</p>}
              {row.usd != null && <p className="num text-xs text-cyan">{formatUsd(row.usd)}</p>}
              {row.signature && (
                <a className="text-xs text-cyan" href={solscanTx(row.signature)} target="_blank" rel="noreferrer">
                  Tx
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function autoLine(input: {
  killed: boolean;
  mode: Mode;
  balance: number | null;
  leaders: number;
  size: number;
  blocker: string | null;
}) {
  if (input.killed) return "Stopped. Release the switch before auto can run.";
  if (input.mode !== "paper") return "Auto is off. Turn on Paper to copy the next fresh buy from these five.";
  if (input.leaders === 0) return "Paper is on, but the top 5 are not loaded yet.";
  if (input.balance == null) return "Paper is on. Waiting for the Paybox balance before a size can be set.";
  if (input.size <= 0) return `Paper is on, but no copy will fire. ${input.blocker || "Size is zero."}`;
  return `Paper is watching ${input.leaders} wallets. The next fresh buy is copied at ${formatSol(input.size)} SOL.`;
}
