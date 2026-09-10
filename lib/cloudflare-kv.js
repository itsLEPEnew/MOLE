/**
 * Accès à RECOS_KV (le même namespace Cloudflare KV utilisé par les Workers) depuis les
 * fonctions Vercel — Vercel n'a pas de binding natif vers KV, donc on passe par l'API REST
 * de Cloudflare. Étape de transition (Phase 1 de la migration) : une fois Supabase en place
 * (Phase 3), ce fichier disparaît et les fonctions liront/écriront Postgres directement.
 *
 * Variables d'environnement requises, à ajouter dans Vercel (Settings > Environment
 * Variables) — jamais commitées ici :
 *   CF_ACCOUNT_ID       — l'ID de compte Cloudflare (Workers & Pages > Overview, colonne
 *                         de droite)
 *   CF_KV_NAMESPACE_ID  — l'ID du namespace "mole_recos" (Workers & Pages > KV > clique le
 *                         namespace > l'ID est affiché en haut)
 *   CF_API_TOKEN        — un token créé sur https://dash.cloudflare.com/profile/api-tokens
 *                         > Create Token > modèle "Edit Cloudflare Workers" suffit (inclut
 *                         les droits KV), ou un token custom avec la permission
 *                         "Account > Workers KV Storage > Edit"
 */

function kvBaseUrl(key) {
  const { CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID } = process.env;
  return `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
}

function authHeaders() {
  return { Authorization: `Bearer ${process.env.CF_API_TOKEN}` };
}

export async function kvGet(key) {
  try {
    const res = await fetch(kvBaseUrl(key), { headers: authHeaders() });
    if (!res.ok) return null; // 404 = clé absente, autre erreur = on retombe sur "pas de cache"
    return await res.text();
  } catch (e) {
    return null;
  }
}

export async function kvPut(key, value, ttlSeconds) {
  try {
    const url = new URL(kvBaseUrl(key));
    if (ttlSeconds) url.searchParams.set("expiration_ttl", String(Math.max(60, ttlSeconds)));
    const form = new FormData();
    form.append("value", value);
    await fetch(url, { method: "PUT", headers: authHeaders(), body: form });
  } catch (e) {
    // une écriture de cache qui échoue n'est pas bloquante — la prochaine requête retentera
  }
}
