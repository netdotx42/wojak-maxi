export const MIN_COPY_SOL = 0.01;
export const NETWORK_FEE_SOL = 0.000025;
export const HARD_MAX_SOL = 2;

export type PlanInput = {
  balanceSol: number;
  allocationPct: number;
  copyPct: number;
  feeReserveSol: number;
  maxPositionSol: number;
  maxExposureSol: number;
  openCostSol: number;
  reservedSol: number;
  perWalletCapSol: number;
  walletOpenSol: number;
  maxConcurrent: number;
  openCount: number;
  dailyRealizedSol: number;
  dailyLossLimitSol: number;
};

export type Plan = {
  sizeSol: number;
  blockers: string[];
  allocatedSol: number;
  tradableSol: number;
  remainingSol: number;
};

function roundSol(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

export function planCopy(input: PlanInput): Plan {
  const allocatedSol = roundSol(
    Math.max(0, input.balanceSol) * (clamp(input.allocationPct, 0, 100) / 100),
  );
  const tradableSol = roundSol(Math.max(0, allocatedSol - Math.max(0, input.feeReserveSol)));
  const remainingSol = roundSol(
    tradableSol - Math.max(0, input.openCostSol) - Math.max(0, input.reservedSol),
  );
  const blockers: string[] = [];
  if (!(input.balanceSol > 0)) blockers.push("No verified SOL balance");
  else if (input.openCount >= input.maxConcurrent) blockers.push("Max concurrent positions reached");
  else if (input.dailyRealizedSol <= -Math.abs(input.dailyLossLimitSol)) {
    blockers.push("Daily loss limit reached");
  } else if (remainingSol <= 0) blockers.push("Allocated capital exhausted");

  const walletRoom = Math.max(0, input.perWalletCapSol - Math.max(0, input.walletOpenSol));
  const exposureRoom = Math.max(
    0,
    input.maxExposureSol - Math.max(0, input.openCostSol) - Math.max(0, input.reservedSol),
  );
  let size = allocatedSol * (clamp(input.copyPct, 0, 100) / 100);
  size = Math.min(
    size,
    Math.max(0, input.maxPositionSol),
    Math.max(0, remainingSol),
    walletRoom,
    exposureRoom,
    HARD_MAX_SOL,
  );
  size = roundSol(size);
  if (blockers.length === 0 && size < MIN_COPY_SOL) {
    blockers.push(`Copy size below ${MIN_COPY_SOL} SOL minimum`);
  }
  if (blockers.length) size = 0;
  return { sizeSol: size, blockers, allocatedSol, tradableSol, remainingSol };
}

export function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function isSolAddress(value: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

export function shortAddr(value: string) {
  if (value.length < 10) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function formatSol(n: number | null | undefined, digits = 4) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const d = abs >= 100 ? 2 : abs >= 1 ? 3 : digits;
  return n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
}

export function formatUsd(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (abs >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}

export function formatAge(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

export function solscanTx(sig: string) {
  return `https://solscan.io/tx/${sig}`;
}
export function solscanAccount(addr: string) {
  return `https://solscan.io/account/${addr}`;
}
export function pumpCoin(mint: string) {
  return `https://pump.fun/coin/${mint}`;
}
