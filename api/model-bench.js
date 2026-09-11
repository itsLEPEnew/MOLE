/**
 * BANC D'ESSAI TEMPORAIRE — à supprimer une fois le modèle du chat choisi.
 *
 * Permet de rejouer le prompt système et les outils réels de la Taupe sur un modèle
 * Workers AI arbitraire, pour comparer sur pièces le respect de la consigne hors-sujet,
 * la justesse du tool-calling et la latence. Protégé par CRON_SECRET : sans lui, 401.
 */
import { SYSTEM_INSTRUCTION, TOOLS } from "../lib/mole-chat-core.js";

export const config = { runtime: "edge" };

export default async function handler(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== process.env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const model = url.searchParams.get("model");
  const message = url.searchParams.get("q") || "bonjour";
  const temperature = Number(url.searchParams.get("temp") ?? 0.8);

  const started = Date.now();
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: SYSTEM_INSTRUCTION },
            { role: "user", content: message },
          ],
          tools: TOOLS,
          max_tokens: 400,
          temperature,
        }),
      }
    );
    const data = await res.json().catch(() => null);
    const ms = Date.now() - started;
    if (!res.ok || !data?.success) {
      return json({ model, ms, error: data?.errors?.map((e) => e.message).join(", ") || `HTTP ${res.status}` });
    }
    const m = data.result?.choices?.[0]?.message || {};
    const calls = m.tool_calls || [];
    return json({
      model,
      ms,
      toolCall: calls.length ? (calls[0].function || calls[0]).name : null,
      reply: (m.content || "").slice(0, 300),
    });
  } catch (e) {
    return json({ model, ms: Date.now() - started, error: String(e) });
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
