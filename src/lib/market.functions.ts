import { createServerFn } from "@tanstack/react-start";
import { isSolAddress } from "./risk";

export const getFeed = createServerFn({ method: "GET" }).handler(async () => {
  const { getFeedSnapshot } = await import("./market.server");
  return getFeedSnapshot();
});

export const getBalances = createServerFn({ method: "POST" })
  .validator((data: { addresses: string[] }) => {
    const addresses = Array.isArray(data?.addresses) ? data.addresses.filter(isSolAddress).slice(0, 5) : [];
    return { addresses };
  })
  .handler(async ({ data }) => {
    const { getBalances: read } = await import("./market.server");
    return read(data.addresses);
  });

export const scanWallets = createServerFn({ method: "POST" })
  .validator((data: { addresses: string[] }) => {
    const addresses = Array.isArray(data?.addresses) ? data.addresses.filter(isSolAddress).slice(0, 5) : [];
    return { addresses };
  })
  .handler(async ({ data }) => {
    const { scanWallets: scan } = await import("./market.server");
    return scan(data.addresses);
  });

export const previewBuy = createServerFn({ method: "POST" })
  .validator((data: { mint: string; lamports: number; slippageBps: number }) => ({
    mint: String(data?.mint || ""),
    lamports: Number(data?.lamports || 0),
    slippageBps: Number(data?.slippageBps || 300),
  }))
  .handler(async ({ data }) => {
    const { evaluateBuy } = await import("./market.server");
    return evaluateBuy(data);
  });

export const previewSell = createServerFn({ method: "POST" })
  .validator((data: { mint: string; amountRaw: string; slippageBps: number }) => ({
    mint: String(data?.mint || ""),
    amountRaw: String(data?.amountRaw || "0"),
    slippageBps: Number(data?.slippageBps || 300),
  }))
  .handler(async ({ data }) => {
    const { evaluateSell } = await import("./market.server");
    return evaluateSell(data);
  });

export const getSmartFlow = createServerFn({ method: "GET" }).handler(async () => {
  const { getSmartFlow: read } = await import("./market.server");
  return read();
});

export const getTopTraders = createServerFn({ method: "GET" }).handler(async () => {
  const { getTopTraders: read } = await import("./market.server");
  return read();
});

export const tokenBrief = createServerFn({ method: "POST" })
  .validator((data: { mint: string }) => ({ mint: String(data?.mint || "") }))
  .handler(async ({ data }) => {
    const { getTokenBrief } = await import("./market.server");
    return { token: await getTokenBrief(data.mint) };
  });
