import { HARD_MAX_SOL, isSolAddress } from "./risk";

const PUMP_WS = "wss://pumpportal.fun/api/data";
const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const SOL_MINT = "So11111111111111111111111111111111111111112";
const IGNORE_MINTS = new Set([
  SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

export type StreamEvent = {
  signature: string;
  mint: string;
  trader: string;
  txType: string;
  solAmount: number;
  name: string;
  symbol: string;
  marketCapSol: number | null;
  vSol: number | null;
  bondingCurve: string | null;
  pool: string | null;
  receivedAt: number;
};

export type FeedHealth = {
  pump: { connected: boolean; lastEventAt: number | null; lastError: string | null; note: string | null };
  rpc: { ok: boolean; endpoint: string | null; checkedAt: number | null; error: string | null };
  jupiter: { ok: boolean; checkedAt: number | null; error: string | null };
  dexscreener: { ok: boolean; checkedAt: number | null; error: string | null };
  solPriceUsd: number | null;
  solPriceAt: number | null;
};

export type TokenBrief = {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  launchpad: string | null;
  holderCount: number | null;
  liquidityUsd: number | null;
  usdPrice: number | null;
  mcapUsd: number | null;
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  topHoldersPct: number | null;
  devBalancePct: number | null;
  organicLabel: string | null;
  fetchedAt: number;
};

export type Quote = {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: number;
  routeLabels: string[];
  inputMint: string;
  outputMint: string;
  slippageBps: number;
  quotedAt: number;
  id: string;
};

export type SwapSignal = {
  signature: string;
  wallet: string;
  side: "buy" | "sell";
  mint: string;
  solDelta: number;
  tokenDelta: number;
  tokenPre: number;
  tokenDecimals: number;
  soldPct: number | null;
  blockTime: number | null;
  err: null;
  source: "rpc-balance-delta";
};

type Hub = {
  ws: WebSocket | null;
  events: StreamEvent[];
  seen: Set<string>;
  connecting: boolean;
  backoff: number;
  health: FeedHealth;
  tokenCache: Map<string, { at: number; brief: TokenBrief | null }>;
  started: boolean;
};

function hub(): Hub {
  const g = globalThis as unknown as { __wojakHub?: Hub };
  if (!g.__wojakHub) {
    g.__wojakHub = {
      ws: null,
      events: [],
      seen: new Set(),
      connecting: false,
      backoff: 800,
      tokenCache: new Map(),
      started: false,
      health: {
        pump: { connected: false, lastEventAt: null, lastError: null, note: null },
        rpc: { ok: false, endpoint: null, checkedAt: null, error: null },
        jupiter: { ok: false, checkedAt: null, error: null },
        dexscreener: { ok: false, checkedAt: null, error: null },
        solPriceUsd: null,
        solPriceAt: null,
      },
    };
  }
  return g.__wojakHub;
}

async function fetchText(url: string, init: RequestInit = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<{ result: T; endpoint: string }> {
  let last = "rpc failed";
  for (const endpoint of RPCS) {
    try {
      const { ok, text, status } = await fetchText(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        },
        9000,
      );
      const json = JSON.parse(text) as { result?: T; error?: { message?: string } };
      if (!ok || json.error || json.result === undefined) {
        last = json.error?.message || `HTTP ${status}`;
        continue;
      }
      return { result: json.result, endpoint };
    } catch (error) {
      last = error instanceof Error ? error.message : "rpc error";
    }
  }
  throw new Error(last);
}

function connectPump() {
  const state = hub();
  if (state.connecting) return;
  const existing = state.ws;
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
    return;
  }
  state.connecting = true;
  let ws: WebSocket;
  try {
    ws = new WebSocket(PUMP_WS);
  } catch (error) {
    state.connecting = false;
    state.health.pump.lastError = error instanceof Error ? error.message : "socket failed";
    state.health.pump.connected = false;
    return;
  }
  state.ws = ws;
  ws.addEventListener("open", () => {
    state.connecting = false;
    state.backoff = 800;
    state.health.pump.connected = true;
    state.health.pump.lastError = null;
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    ws.send(JSON.stringify({ method: "subscribeMigration" }));
  });
  ws.addEventListener("message", (ev) => {
    ingest(String(ev.data));
  });
  ws.addEventListener("error", () => {
    state.health.pump.lastError = "PumpPortal socket error";
    state.health.pump.connected = false;
  });
  ws.addEventListener("close", () => {
    state.connecting = false;
    state.health.pump.connected = false;
    if (state.ws === ws) state.ws = null;
    const wait = state.backoff;
    state.backoff = Math.min(15_000, state.backoff * 2);
    setTimeout(() => connectPump(), wait);
  });
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function ingest(raw: string) {
  const state = hub();
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof msg.message === "string" && !msg.mint) {
    state.health.pump.note = msg.message;
    return;
  }
  const signature = typeof msg.signature === "string" ? msg.signature : "";
  const mint = typeof msg.mint === "string" ? msg.mint : "";
  const trader = typeof msg.traderPublicKey === "string" ? msg.traderPublicKey : "";
  if (!signature || !mint || !trader) return;
  if (state.seen.has(signature)) return;
  state.seen.add(signature);
  if (state.seen.size > 2000) {
    const drop = [...state.seen].slice(0, 500);
    for (const sig of drop) state.seen.delete(sig);
  }
  const event: StreamEvent = {
    signature,
    mint,
    trader,
    txType: typeof msg.txType === "string" ? msg.txType : "unknown",
    solAmount: num(msg.solAmount) ?? 0,
    name: typeof msg.name === "string" ? msg.name.trim().slice(0, 48) : "Unknown",
    symbol: typeof msg.symbol === "string" ? msg.symbol.trim().slice(0, 16) : "?",
    marketCapSol: num(msg.marketCapSol),
    vSol: num(msg.vSolInBondingCurve),
    bondingCurve: typeof msg.bondingCurveKey === "string" ? msg.bondingCurveKey : null,
    pool: typeof msg.pool === "string" ? msg.pool : null,
    receivedAt: Date.now(),
  };
  state.events.unshift(event);
  if (state.events.length > 80) state.events.length = 80;
  state.health.pump.lastEventAt = event.receivedAt;
  state.health.pump.connected = true;
}

async function refreshSlowHealth() {
  const state = hub();
  const now = Date.now();
  if (!state.health.solPriceAt || now - state.health.solPriceAt > 20_000) {
    try {
      const { ok, text } = await fetchText(
        `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`,
        {},
        7000,
      );
      const json = JSON.parse(text) as Record<string, { usdPrice?: number }>;
      const price = json[SOL_MINT]?.usdPrice;
      if (!ok || !(typeof price === "number")) throw new Error("SOL price unavailable");
      state.health.solPriceUsd = price;
      state.health.solPriceAt = now;
      state.health.jupiter = { ok: true, checkedAt: now, error: null };
    } catch (error) {
      state.health.jupiter = {
        ok: false,
        checkedAt: now,
        error: error instanceof Error ? error.message : "Jupiter unreachable",
      };
    }
  }
  if (!state.health.rpc.checkedAt || now - state.health.rpc.checkedAt > 25_000) {
    try {
      const { result, endpoint } = await rpcCall<string>("getHealth", []);
      state.health.rpc = {
        ok: result === "ok" || result === "healthy" || typeof result === "string",
        endpoint,
        checkedAt: now,
        error: null,
      };
    } catch (error) {
      state.health.rpc = {
        ok: false,
        endpoint: null,
        checkedAt: now,
        error: error instanceof Error ? error.message : "RPC unreachable",
      };
    }
  }
  if (!state.health.dexscreener.checkedAt || now - state.health.dexscreener.checkedAt > 60_000) {
    try {
      const { ok, status } = await fetchText("https://api.dexscreener.com/token-profiles/latest/v1", {}, 8000);
      state.health.dexscreener = {
        ok,
        checkedAt: now,
        error: ok ? null : `HTTP ${status}`,
      };
    } catch (error) {
      state.health.dexscreener = {
        ok: false,
        checkedAt: now,
        error: error instanceof Error ? error.message : "Dexscreener unreachable",
      };
    }
  }
}

export async function getFeedSnapshot() {
  const state = hub();
  state.started = true;
  connectPump();
  if (state.events.length === 0) {
    await new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (state.events.length > 0 || Date.now() - start > 2800) resolve(null);
        else setTimeout(tick, 150);
      };
      tick();
    });
  }
  await refreshSlowHealth();
  return {
    events: state.events.slice(0, 40),
    health: state.health,
    receivedAt: Date.now(),
  };
}

export async function getBalances(addresses: string[]) {
  const unique = [...new Set(addresses.map((a) => a.trim()).filter(isSolAddress))].slice(0, 5);
  const out: { address: string; lamports: number | null; error: string | null }[] = [];
  for (const address of unique) {
    try {
      const { result } = await rpcCall<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
      out.push({ address, lamports: result.value, error: null });
    } catch (error) {
      out.push({
        address,
        lamports: null,
        error: error instanceof Error ? error.message : "balance failed",
      });
    }
  }
  return { balances: out, fetchedAt: Date.now() };
}

type ParsedTx = {
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBal[];
    postTokenBalances?: TokenBal[];
    logMessages?: string[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  } | null;
  blockTime: number | null;
  transaction: {
    message: { accountKeys: ({ pubkey: string } | string)[] };
  };
};

type TokenBal = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { uiAmount: number | null; decimals: number; amount: string };
};

function accountList(tx: ParsedTx) {
  const keys = (tx.transaction.message.accountKeys || []).map((k) =>
    typeof k === "string" ? k : k.pubkey,
  );
  const loaded = tx.meta?.loadedAddresses;
  if (loaded?.writable) keys.push(...loaded.writable);
  if (loaded?.readonly) keys.push(...loaded.readonly);
  return keys;
}

export function classifyTransaction(tx: ParsedTx, wallet: string, signature: string): SwapSignal | "other" | "failed" {
  if (!tx.meta) return "other";
  if (tx.meta.err) return "failed";
  const keys = accountList(tx);
  const idx = keys.indexOf(wallet);
  if (idx < 0) return "other";
  const preSol = tx.meta.preBalances[idx] ?? 0;
  const postSol = tx.meta.postBalances[idx] ?? 0;
  const solDelta = (postSol - preSol) / 1e9;
  const owned = (rows: TokenBal[] | undefined) => {
    const map = new Map<string, { ui: number; decimals: number }>();
    for (const row of rows || []) {
      if (row.owner !== wallet || IGNORE_MINTS.has(row.mint)) continue;
      const ui = row.uiTokenAmount?.uiAmount ?? 0;
      const prev = map.get(row.mint);
      map.set(row.mint, {
        ui: (prev?.ui ?? 0) + ui,
        decimals: row.uiTokenAmount?.decimals ?? prev?.decimals ?? 0,
      });
    }
    return map;
  };
  const pre = owned(tx.meta.preTokenBalances);
  const post = owned(tx.meta.postTokenBalances);
  const mints = new Set([...pre.keys(), ...post.keys()]);
  let best: { mint: string; delta: number; pre: number; decimals: number } | null = null;
  for (const mint of mints) {
    const delta = (post.get(mint)?.ui ?? 0) - (pre.get(mint)?.ui ?? 0);
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = { mint, delta, pre: pre.get(mint)?.ui ?? 0, decimals: post.get(mint)?.decimals ?? pre.get(mint)?.decimals ?? 0 };
    }
  }
  if (!best || Math.abs(best.delta) === 0) return "other";
  const logs = (tx.meta.logMessages || []).join("\n");
  const logBuy = /Instruction:\s*Buy/.test(logs);
  const logSell = /Instruction:\s*Sell/.test(logs);
  let side: "buy" | "sell" | null = null;
  if (best.delta > 0 && solDelta < -0.0005) side = "buy";
  else if (best.delta < 0 && solDelta > 0.0005) side = "sell";
  else if (logBuy && !logSell && best.delta > 0) side = "buy";
  else if (logSell && !logBuy && best.delta < 0) side = "sell";
  if (!side) return "other";
  const soldPct =
    side === "sell" && best.pre > 0 ? Math.max(0, Math.min(1, Math.abs(best.delta) / best.pre)) : null;
  return {
    signature,
    wallet,
    side,
    mint: best.mint,
    solDelta,
    tokenDelta: best.delta,
    tokenPre: best.pre,
    tokenDecimals: best.decimals,
    soldPct,
    blockTime: tx.blockTime,
    err: null,
    source: "rpc-balance-delta",
  };
}

export async function scanWallets(addresses: string[]) {
  const unique = [...new Set(addresses.map((a) => a.trim()).filter(isSolAddress))].slice(0, 5);
  const signals: SwapSignal[] = [];
  const notes: { wallet: string; signature: string; status: string }[] = [];
  for (const wallet of unique) {
    let sigs: { signature: string; err: unknown; blockTime: number | null; confirmationStatus?: string }[] = [];
    try {
      const { result } = await rpcCall<typeof sigs>("getSignaturesForAddress", [
        wallet,
        { limit: 6, commitment: "confirmed" },
      ]);
      sigs = result;
    } catch (error) {
      notes.push({
        wallet,
        signature: "",
        status: error instanceof Error ? error.message : "signature lookup failed",
      });
      continue;
    }
    let parsed = 0;
    for (const row of sigs) {
      if (parsed >= 3) break;
      if (row.err) {
        notes.push({ wallet, signature: row.signature, status: "failed" });
        continue;
      }
      parsed += 1;
      try {
        const { result } = await rpcCall<ParsedTx | null>("getTransaction", [
          row.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
        ]);
        if (!result) {
          notes.push({ wallet, signature: row.signature, status: "missing" });
          continue;
        }
        const classified = classifyTransaction(result, wallet, row.signature);
        if (classified === "other" || classified === "failed") {
          notes.push({ wallet, signature: row.signature, status: classified });
        } else {
          signals.push(classified);
          notes.push({ wallet, signature: row.signature, status: classified.side });
        }
      } catch (error) {
        notes.push({
          wallet,
          signature: row.signature,
          status: error instanceof Error ? error.message : "tx parse failed",
        });
      }
    }
  }
  return { signals, notes, fetchedAt: Date.now() };
}

function mapBrief(mint: string, raw: Record<string, unknown> | undefined): TokenBrief | null {
  if (!raw || raw.id !== mint) return null;
  const audit = (raw.audit || {}) as Record<string, unknown>;
  return {
    mint,
    name: String(raw.name || "Unknown").slice(0, 48),
    symbol: String(raw.symbol || "?").slice(0, 16),
    decimals: typeof raw.decimals === "number" ? raw.decimals : 6,
    launchpad: typeof raw.launchpad === "string" ? raw.launchpad : null,
    holderCount: typeof raw.holderCount === "number" ? raw.holderCount : null,
    liquidityUsd: typeof raw.liquidity === "number" ? raw.liquidity : null,
    usdPrice: typeof raw.usdPrice === "number" ? raw.usdPrice : null,
    mcapUsd: typeof raw.mcap === "number" ? raw.mcap : null,
    mintAuthorityDisabled: typeof audit.mintAuthorityDisabled === "boolean" ? audit.mintAuthorityDisabled : null,
    freezeAuthorityDisabled:
      typeof audit.freezeAuthorityDisabled === "boolean" ? audit.freezeAuthorityDisabled : null,
    topHoldersPct: typeof audit.topHoldersPercentage === "number" ? audit.topHoldersPercentage : null,
    devBalancePct: typeof audit.devBalancePercentage === "number" ? audit.devBalancePercentage : null,
    organicLabel: typeof raw.organicScoreLabel === "string" ? raw.organicScoreLabel : null,
    fetchedAt: Date.now(),
  };
}

export async function getTokenBrief(mint: string): Promise<TokenBrief | null> {
  if (!isSolAddress(mint)) return null;
  const state = hub();
  const cached = state.tokenCache.get(mint);
  if (cached && Date.now() - cached.at < 15_000) return cached.brief;
  try {
    const { ok, text } = await fetchText(
      `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`,
      {},
      8000,
    );
    if (!ok) throw new Error("token search failed");
    const rows = JSON.parse(text) as Record<string, unknown>[];
    const brief = mapBrief(
      mint,
      rows.find((row) => row.id === mint),
    );
    state.tokenCache.set(mint, { at: Date.now(), brief });
    return brief;
  } catch {
    state.tokenCache.set(mint, { at: Date.now(), brief: cached?.brief ?? null });
    return cached?.brief ?? null;
  }
}

async function jupQuote(inputMint: string, outputMint: string, amount: string, slippageBps: number): Promise<Quote> {
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}` +
    `&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const { ok, text, status } = await fetchText(url, {}, 9000);
  const json = JSON.parse(text) as {
    error?: string;
    inAmount?: string;
    outAmount?: string;
    otherAmountThreshold?: string;
    priceImpactPct?: string;
    routePlan?: { swapInfo?: { label?: string } }[];
    inputMint?: string;
    outputMint?: string;
  };
  if (!ok || !json.outAmount || !json.inAmount) {
    throw new Error(json.error || `quote HTTP ${status}`);
  }
  return {
    inAmount: json.inAmount,
    outAmount: json.outAmount,
    otherAmountThreshold: json.otherAmountThreshold || json.outAmount,
    priceImpactPct: Number(json.priceImpactPct || 0),
    routeLabels: (json.routePlan || []).map((hop) => hop.swapInfo?.label || "route").filter(Boolean),
    inputMint: json.inputMint || inputMint,
    outputMint: json.outputMint || outputMint,
    slippageBps,
    quotedAt: Date.now(),
    id: stashQuote(json as Record<string, unknown>),
  };
}

const quoteVault = new Map<string, { at: number; raw: Record<string, unknown> }>();

function stashQuote(raw: Record<string, unknown>) {
  const now = Date.now();
  for (const [id, row] of quoteVault) {
    if (now - row.at > 60_000) quoteVault.delete(id);
  }
  const id = crypto.randomUUID();
  quoteVault.set(id, { at: now, raw });
  return id;
}

export type EvalCheck = { id: string; pass: boolean; detail: string };

export async function evaluateBuy(input: { mint: string; lamports: number; slippageBps: number }) {
  const checks: EvalCheck[] = [];
  const mintOk = isSolAddress(input.mint);
  checks.push({
    id: "mint",
    pass: mintOk,
    detail: mintOk ? input.mint : "Mint is not a Solana address",
  });
  const lamports = Math.floor(input.lamports);
  const sizeOk = lamports >= 1_000_000 && lamports <= HARD_MAX_SOL * 1e9;
  checks.push({
    id: "size",
    pass: sizeOk,
    detail: sizeOk ? `${lamports} lamports` : "Size outside 0.001–2 SOL hard bounds",
  });
  const slippageBps = Math.max(10, Math.min(2000, Math.floor(input.slippageBps) || 300));
  if (!mintOk || !sizeOk) {
    return { ok: false, checks, quote: null as Quote | null, token: null as TokenBrief | null };
  }
  const token = await getTokenBrief(input.mint);
  checks.push({
    id: "metadata",
    pass: !!token,
    detail: token ? `${token.symbol} · ${token.launchpad || "launchpad unknown"}` : "Jupiter has no verified token record yet",
  });
  const launchpadPump = token?.launchpad === "pump.fun";
  const suffixPump = input.mint.toLowerCase().endsWith("pump");
  const pump = !!token && (launchpadPump || suffixPump);
  checks.push({
    id: "venue",
    pass: pump,
    detail: launchpadPump
      ? "Jupiter lists launchpad pump.fun"
      : suffixPump
        ? "Mint uses the pump suffix; launchpad field not confirmed"
        : "Not confirmed as a Pump.fun token",
  });
  checks.push({
    id: "mint-authority",
    pass: token?.mintAuthorityDisabled === true,
    detail:
      token?.mintAuthorityDisabled === true
        ? "Mint authority disabled"
        : token?.mintAuthorityDisabled === false
          ? "Mint authority still enabled"
          : "Mint authority unverified",
  });
  checks.push({
    id: "freeze-authority",
    pass: token?.freezeAuthorityDisabled === true,
    detail:
      token?.freezeAuthorityDisabled === true
        ? "Freeze authority disabled"
        : token?.freezeAuthorityDisabled === false
          ? "Freeze authority enabled"
          : "Freeze authority unverified",
  });
  const holdersKnown = token?.topHoldersPct != null || token?.devBalancePct != null;
  const holdersPass =
    !!token &&
    (token.topHoldersPct == null || token.topHoldersPct <= 55) &&
    (token.devBalancePct == null || token.devBalancePct <= 12) &&
    holdersKnown;
  checks.push({
    id: "holders",
    pass: holdersPass,
    detail: !token
      ? "Holder data unavailable"
      : !holdersKnown
        ? "Holder concentration not published yet"
        : `Top holders ${token.topHoldersPct ?? "—"}% · dev ${token.devBalancePct ?? "—"}%`,
  });
  const liq = token?.liquidityUsd ?? null;
  checks.push({
    id: "liquidity",
    pass: liq != null && liq >= 800,
    detail: liq == null ? "Liquidity unverified" : `Indexed liquidity ${Math.round(liq)} USD`,
  });
  let quote: Quote | null = null;
  try {
    quote = await jupQuote(SOL_MINT, input.mint, String(lamports), slippageBps);
    const impactOk = quote.priceImpactPct <= slippageBps / 10_000;
    checks.push({
      id: "quote",
      pass: true,
      detail: `Executable Jupiter quote · impact ${(quote.priceImpactPct * 100).toFixed(2)}% · ${quote.routeLabels.join(" → ") || "route"}`,
    });
    checks.push({
      id: "impact",
      pass: impactOk,
      detail: impactOk
        ? "Price impact inside slippage budget"
        : `Price impact ${(quote.priceImpactPct * 100).toFixed(2)}% exceeds slippage`,
    });
    const onPump = quote.routeLabels.some((label) => /pump/i.test(label));
    if (!pump && onPump) {
      const venue = checks.find((c) => c.id === "venue");
      if (venue) {
        venue.pass = true;
        venue.detail = "Quote routes through Pump.fun";
      }
    }
    const holders = checks.find((c) => c.id === "holders");
    const liquidity = checks.find((c) => c.id === "liquidity");
    const concentrationOk =
      !!token &&
      (token.topHoldersPct == null || token.topHoldersPct <= 55) &&
      (token.devBalancePct == null || token.devBalancePct <= 12);
    if (holders && !holders.pass && onPump && concentrationOk && token?.mintAuthorityDisabled && token.freezeAuthorityDisabled) {
      holders.pass = true;
      holders.detail = "Concentration not indexed yet. Live Pump.fun quote accepted.";
    }
    if (liquidity && !liquidity.pass && onPump && (token?.liquidityUsd == null || token.liquidityUsd >= 800)) {
      liquidity.pass = true;
      liquidity.detail =
        token?.liquidityUsd == null
          ? "Indexed liquidity missing. Executable Pump.fun quote used."
          : liquidity.detail;
    }
  } catch (error) {
    checks.push({
      id: "quote",
      pass: false,
      detail: error instanceof Error ? error.message : "No executable quote",
    });
    checks.push({ id: "impact", pass: false, detail: "No quote to measure impact" });
  }
  const ok = checks.every((check) => check.pass);
  return { ok, checks, quote, token };
}

export async function evaluateSell(input: { mint: string; amountRaw: string; slippageBps: number }) {
  const slippageBps = Math.max(10, Math.min(2000, Math.floor(input.slippageBps) || 300));
  if (!isSolAddress(input.mint) || !/^\d+$/.test(input.amountRaw) || input.amountRaw === "0") {
    return { ok: false as const, error: "Invalid sell request", quote: null as Quote | null };
  }
  try {
    const quote = await jupQuote(input.mint, SOL_MINT, input.amountRaw, slippageBps);
    return { ok: true as const, error: null, quote };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Sell quote failed",
      quote: null,
    };
  }
}

export async function buildSwapTx(input: { quoteId: string; userPublicKey: string }) {
  if (!isSolAddress(input.userPublicKey)) throw new Error("Signer is not a Solana address");
  const stored = quoteVault.get(input.quoteId);
  if (!stored || Date.now() - stored.at > 60_000) throw new Error("Quote expired. Try the order again.");
  quoteVault.delete(input.quoteId);
  const { ok, text, status } = await fetchText(
    "https://lite-api.jup.ag/swap/v1/swap",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: stored.raw,
        userPublicKey: input.userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    },
    12000,
  );
  const json = JSON.parse(text) as { swapTransaction?: string; error?: string };
  if (!ok || !json.swapTransaction) throw new Error(json.error || `Swap build failed (${status})`);
  return { tx: json.swapTransaction };
}

export async function broadcastSigned(tx: string) {
  if (!/^[A-Za-z0-9+/=]+$/.test(tx) || tx.length < 80 || tx.length > 4000) {
    throw new Error("Signed transaction is not usable");
  }
  const { result } = await rpcCall<string>("sendTransaction", [
    tx,
    { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 2 },
  ]);
  return { signature: result };
}

export type TopTrader = {
  address: string;
  pnlUsd: number;
  trades: number;
  tokens: number;
};

type TopBoard = {
  traders: TopTrader[];
  source: string;
  error: string | null;
  fetchedAt: number;
};

let topCache: { at: number; board: TopBoard } | null = null;

export async function getTopTraders(): Promise<TopBoard> {
  if (topCache && Date.now() - topCache.at < 45_000) return topCache.board;
  const board = await loadTopTraders();
  if (board.traders.length) topCache = { at: Date.now(), board };
  return board;
}

async function loadTopTraders(): Promise<TopBoard> {
  const fetchedAt = Date.now();
  try {
    const lists = await Promise.all([
      jupHot("5m"),
      jupHot("1h"),
    ]);
    const mints: { mint: string; symbol: string }[] = [];
    const seen = new Set<string>();
    for (const row of lists.flat()) {
      if (seen.has(row.mint) || mints.length >= 6) continue;
      seen.add(row.mint);
      mints.push(row);
    }
    if (!mints.length) {
      return { traders: [], source: "Jupiter", error: "No hot Pump.fun tokens in the last hour.", fetchedAt };
    }
    const books = await Promise.all(mints.map((row) => mevxTraders(row.mint)));
    if (!books.some((book) => book.length)) {
      return { traders: [], source: "MEVX", error: "Trader books did not load.", fetchedAt };
    }
    const totals = new Map<string, TopTrader>();
    for (const book of books) {
      for (const row of book) {
        if (!isSolAddress(row.wallet) || !Number.isFinite(row.pnl)) continue;
        const current = totals.get(row.wallet) || { address: row.wallet, pnlUsd: 0, trades: 0, tokens: 0 };
        current.pnlUsd += row.pnl;
        current.trades += row.trades;
        current.tokens += 1;
        totals.set(row.wallet, current);
      }
    }
    const traders = [...totals.values()]
      .filter((row) => row.pnlUsd > 0)
      .sort((a, b) => b.pnlUsd - a.pnlUsd)
      .slice(0, 5)
      .map((row) => ({ ...row, pnlUsd: Math.round(row.pnlUsd * 100) / 100 }));
    return {
      traders,
      source: `MEVX PnL on ${mints.length} hot Pump.fun tokens`,
      error: traders.length ? null : "No positive PnL wallets on the current hot tokens.",
      fetchedAt,
    };
  } catch (error) {
    return {
      traders: [],
      source: "MEVX",
      error: error instanceof Error ? error.message : "Leaderboard failed",
      fetchedAt,
    };
  }
}

async function jupHot(window: "5m" | "1h") {
  const { ok, text } = await fetchText(`https://lite-api.jup.ag/tokens/v2/toptraded/${window}?limit=40`, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
  }, 12000);
  if (!ok) return [];
  const rows = JSON.parse(text) as { id?: string; symbol?: string; launchpad?: string }[];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row.id && (row.launchpad === "pump.fun" || row.id.endsWith("pump")))
    .map((row) => ({ mint: String(row.id), symbol: String(row.symbol || "") }));
}

async function mevxTraders(mint: string) {
  const { ok, text } = await fetchText(
    `https://api.mevx.io/api/v1/traders?chain=sol&token=${encodeURIComponent(mint)}&limit=20`,
    { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } },
    12000,
  );
  if (!ok) return [];
  const json = JSON.parse(text) as {
    traders?: { wallet?: string; pnl?: string; buy?: { trades?: number }; sell?: { trades?: number } }[];
  };
  return (json.traders || []).map((row) => ({
    wallet: String(row.wallet || ""),
    pnl: Number(row.pnl),
    trades: Number(row.buy?.trades || 0) + Number(row.sell?.trades || 0),
  }));
}

const AXIOM_FEES = [
  "4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz",
  "7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws",
  "9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP",
  "DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy",
];

export type SmartMove = {
  venue: "axiom" | "fomo";
  wallet: string;
  label: string | null;
  pnlUsd: number | null;
  side: "buy" | "sell" | null;
  mint: string | null;
  sol: number | null;
  usd: number | null;
  signature: string | null;
  at: number | null;
};

export type SmartFlow = {
  axiom: SmartMove[];
  fomo: SmartMove[];
  note: string;
  fetchedAt: number;
};

let smartCache: { at: number; flow: SmartFlow } | null = null;

export async function getSmartFlow(): Promise<SmartFlow> {
  if (smartCache && Date.now() - smartCache.at < 40_000) return smartCache.flow;
  const flow = await loadSmartFlow();
  if (flow.axiom.length || flow.fomo.length) smartCache = { at: Date.now(), flow };
  return flow;
}

async function loadSmartFlow(): Promise<SmartFlow> {
  const [axiom, fomo] = await Promise.all([axiomMoves(), fomoMoves()]);
  return {
    axiom,
    fomo,
    note: "Axiom rows are live fee-wallet swaps. FOMO rows are the 24h leaderboard, then their latest chain swap.",
    fetchedAt: Date.now(),
  };
}

async function recentSigs(address: string, limit: number) {
  const { result } = await rpcCall<{ signature: string; err: unknown; blockTime: number | null }[]>(
    "getSignaturesForAddress",
    [address, { limit, commitment: "confirmed" }],
  );
  return result || [];
}

async function readTx(signature: string) {
  const { result } = await rpcCall<ParsedTx | null>("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ]);
  return result;
}

function signerOf(tx: ParsedTx) {
  const key = tx.transaction?.message?.accountKeys?.[0];
  if (!key) return null;
  return typeof key === "string" ? key : key.pubkey;
}

async function latestSwap(wallet: string, limit = 4): Promise<{ side: "buy" | "sell"; mint: string; sol: number | null; usd: number | null; signature: string; at: number | null } | null> {
  const sigs = await recentSigs(wallet, limit);
  let parsed = 0;
  for (const row of sigs) {
    if (row.err || parsed >= 8) continue;
    parsed += 1;
    const tx = await readTx(row.signature);
    if (!tx) continue;
    const classified = classifyTransaction(tx, wallet, row.signature);
    if (classified !== "other" && classified !== "failed") {
      return {
        side: classified.side,
        mint: classified.mint,
        sol: Math.abs(classified.solDelta),
        usd: null,
        signature: classified.signature,
        at: classified.blockTime ? classified.blockTime * 1000 : null,
      };
    }
    const stable = stableSwap(tx, wallet, row.signature);
    if (stable) return stable;
  }
  return null;
}

const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

function stableSwap(tx: ParsedTx, wallet: string, signature: string) {
  if (!tx.meta || tx.meta.err) return null;
  const rows = (list: TokenBal[] | undefined) => {
    const map = new Map<string, number>();
    for (const row of list || []) {
      if (row.owner !== wallet) continue;
      map.set(row.mint, (map.get(row.mint) || 0) + (row.uiTokenAmount?.uiAmount || 0));
    }
    return map;
  };
  const pre = rows(tx.meta.preTokenBalances);
  const post = rows(tx.meta.postTokenBalances);
  let token: { mint: string; delta: number } | null = null;
  let usd = 0;
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const delta = (post.get(mint) || 0) - (pre.get(mint) || 0);
    if (!delta) continue;
    if (STABLES.has(mint)) usd += delta;
    else if (!token || Math.abs(delta) > Math.abs(token.delta)) token = { mint, delta };
  }
  if (!token || !usd || Math.sign(token.delta) === Math.sign(usd)) return null;
  return {
    side: token.delta > 0 ? ("buy" as const) : ("sell" as const),
    mint: token.mint,
    sol: null,
    usd: Math.abs(usd),
    signature,
    at: tx.blockTime ? tx.blockTime * 1000 : null,
  };
}

async function axiomMoves(): Promise<SmartMove[]> {
  const found: SmartMove[] = [];
  const seen = new Set<string>();
  for (const fee of AXIOM_FEES) {
    let sigs: { signature: string; err: unknown; blockTime: number | null }[] = [];
    try {
      sigs = await recentSigs(fee, 5);
    } catch {
      continue;
    }
    for (const row of sigs) {
      if (row.err || seen.has(row.signature)) continue;
      seen.add(row.signature);
      try {
        const tx = await readTx(row.signature);
        if (!tx) continue;
        const wallet = signerOf(tx);
        if (!wallet || AXIOM_FEES.includes(wallet) || !isSolAddress(wallet)) continue;
        const classified = classifyTransaction(tx, wallet, row.signature);
        if (classified === "other" || classified === "failed") continue;
        found.push({
          venue: "axiom",
          wallet,
          label: null,
          pnlUsd: null,
          side: classified.side,
          mint: classified.mint,
          sol: Math.abs(classified.solDelta),
          usd: null,
          signature: classified.signature,
          at: classified.blockTime ? classified.blockTime * 1000 : row.blockTime ? row.blockTime * 1000 : null,
        });
      } catch {
        continue;
      }
    }
  }
  return found
    .filter((move) => (move.sol || 0) >= 0.02 || (move.usd || 0) >= 5)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 5);
}

async function fomoMoves(): Promise<SmartMove[]> {
  const { ok, text } = await fetchText(
    "https://api.fomo-api.com/v1/leaderboard?window=24h&board=fomo-parity&limit=4",
    { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } },
    12000,
  );
  if (!ok) return [];
  const json = JSON.parse(text) as {
    data?: { displayName?: string; handle?: string; pnlUsd?: number; wallets?: { chain?: string; address?: string }[] }[];
  };
  const moves: SmartMove[] = [];
  for (const row of json.data || []) {
    const wallet = row.wallets?.find((item) => item.chain === "solana" && isSolAddress(item.address || ""))?.address;
    if (!wallet) continue;
    let swap: Awaited<ReturnType<typeof latestSwap>> = null;
    try {
      swap = await latestSwap(wallet, 8);
    } catch {
      swap = null;
    }
    moves.push({
      venue: "fomo",
      wallet,
      label: row.displayName || row.handle || null,
      pnlUsd: typeof row.pnlUsd === "number" ? row.pnlUsd : null,
      side: swap?.side ?? null,
      mint: swap?.mint ?? null,
      sol: swap?.sol ?? null,
      usd: swap?.usd ?? null,
      signature: swap?.signature ?? null,
      at: swap?.at ?? null,
    });
  }
  return moves;
}
