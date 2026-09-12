/**
 * Pont REST vers Supabase (PostgREST) pour les 3 collections qui méritent une vraie base
 * plutôt qu'un cache KV : la file d'attente, le mur publié, les abonnements push. Le reste
 * (recherches iTunes/Deezer en cache, TTL courte) reste sur Cloudflare KV — voir
 * cloudflare-kv.js, qui garde son rôle inchangé pour ces clés-là.
 *
 * Expose un shim .get(key)/.put(key, value) qui imite EXACTEMENT l'interface RECOS_KV que
 * lib/mole-admin-core.js attend déjà (get renvoie une chaîne JSON ou null, put l'écrit) :
 * aucune des ~8 routes qui lisent/écrivent "queue"/"wall"/"push_subscriptions" n'a donc
 * besoin de changer, seul l'objet passé en tant qu'`env.RECOS_KV` change de tuyauterie
 * (voir mole-admin-env.js).
 *
 * Chaque put() remplace le contenu de la table correspondante (delete-all puis
 * bulk-insert) : même sémantique "tout le blob à chaque écriture" que le KV qu'il
 * remplace. À l'échelle de MOLE (des dizaines de lignes, pas des milliers), ce n'est pas
 * un souci de volumétrie — et ça évite de réécrire les endpoints existants autour d'un
 * modèle ligne-par-ligne.
 *
 * Variables d'environnement requises (Vercel > Environment Variables) :
 *   SUPABASE_URL          — Project URL (Settings > API), sans le /rest/v1 final
 *   SUPABASE_SERVICE_KEY  — clé secrète (Settings > API > Secret keys). PAS la clé
 *                           "Publishable" : celle-ci doit contourner RLS, activé sans
 *                           aucune règle sur les 3 tables (voir supabase-schema.sql) —
 *                           avec la clé publishable, chaque appel échouerait poliment
 *                           (liste vide en lecture, refus en écriture) sans erreur claire.
 */

const TABLES = {
  queue: "recos_queue",
  wall: "recos_wall",
  push_subscriptions: "push_subscriptions",
};

function restUrl(path) {
  const base = process.env.SUPABASE_URL || "REMPLACE_PAR_TON_PROJECT_URL";
  return `${base.replace(/\/$/, "")}/rest/v1/${path}`;
}

function authHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY || "REMPLACE_PAR_TA_CLE_SECRETE";
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function supaSelect(table, query) {
  const res = await fetch(restUrl(`${table}?${query}`), { headers: authHeaders() });
  if (!res.ok) throw new Error(`Supabase SELECT ${table} (${res.status}) : ${await res.text()}`);
  return res.json();
}

async function supaDeleteAll(table, keyCol) {
  // PostgREST refuse un DELETE sans condition -> filtre toujours vrai sur la clé primaire
  const res = await fetch(restUrl(`${table}?${keyCol}=not.is.null`), {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Supabase DELETE ${table} (${res.status}) : ${await res.text()}`);
}

async function supaInsertMany(table, rows) {
  if (!rows.length) return;
  const res = await fetch(restUrl(table), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase INSERT ${table} (${res.status}) : ${await res.text()}`);
}

// sort_order n'existe que pour préserver l'ordre à l'écriture -> jamais renvoyé au front
function stripInternal(row) {
  const { sort_order, ...rest } = row;
  return rest;
}

export async function supaKvGet(key) {
  const table = TABLES[key];
  if (!table) return null; // pas une des 3 collections -> pas notre rayon

  if (key === "push_subscriptions") {
    const rows = await supaSelect(table, "select=subscription");
    return JSON.stringify(rows.map((r) => r.subscription));
  }
  const rows = await supaSelect(table, "select=*&order=sort_order.asc");
  return JSON.stringify(rows.map(stripInternal));
}

export async function supaKvPut(key, value) {
  const table = TABLES[key];
  if (!table) return;
  const arr = JSON.parse(value);

  if (key === "push_subscriptions") {
    await supaDeleteAll(table, "endpoint");
    await supaInsertMany(table, arr.map((sub) => ({ endpoint: sub.endpoint, subscription: sub })));
    return;
  }
  await supaDeleteAll(table, "id");
  await supaInsertMany(table, arr.map((item, i) => ({ ...item, sort_order: i })));
}
