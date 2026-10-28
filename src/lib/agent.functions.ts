import { createServerFn } from "@tanstack/react-start";

export const askMaxi = createServerFn({ method: "POST" })
  .validator((data: { brief: string }) => {
    const brief = String(data?.brief || "").slice(0, 7000);
    if (brief.length < 20) throw new Error("Nothing to analyze yet");
    return { brief };
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false as const, text: "", error: "AI is not available in this environment" };
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        temperature: 0.3,
        max_tokens: 380,
        messages: [
          {
            role: "system",
            content:
              "You are MAXI AGENT 01, the risk analyst inside WOJAKMAXI, a private Pump.fun terminal. " +
              "Use only the JSON snapshot. Never invent PnL, win rate, rankings, or wallet history. " +
              "If a field is missing, say it is unverified. Do not request or accept private keys. " +
              "Do not tell the user to bypass risk checks. Explain skipped trades, whale signals, and portfolio state in under 160 words. " +
              "Plain sentences. No markdown headings.",
          },
          { role: "user", content: data.brief },
        ],
      }),
    });
    if (!res.ok) return { ok: false as const, text: "", error: `xAI API error ${res.status}` };
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim() || "";
    if (!text) return { ok: false as const, text: "", error: "Empty analysis" };
    return { ok: true as const, text, error: null };
  });
