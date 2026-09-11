/**
 * Remplace le Cron Trigger Cloudflare (scheduled()) : publie la file d'attente le vendredi
 * matin, puis envoie la notification push si quelque chose a effectivement été publié.
 *
 * Déclenché par Vercel via l'entrée "crons" de vercel.json (requête GET). Vercel envoie
 * automatiquement l'en-tête Authorization: Bearer <CRON_SECRET> si la variable
 * d'environnement CRON_SECRET est définie — c'est ce qui empêche n'importe qui de
 * déclencher une publication en visitant l'URL.
 *
 * Idempotent : si la file est déjà vide (double déclenchement), publishQueue ne publie rien
 * et aucune notification n'est envoyée.
 */
import { runFridayPublish } from "../../lib/mole-admin-core.js";
import { buildAdminEnv } from "../../lib/mole-admin-env.js";

export const config = { runtime: "edge" };

export default async function handler(request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const result = await runFridayPublish(buildAdminEnv());
    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
