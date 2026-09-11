/**
 * DIAGNOSTIC TEMPORAIRE — à supprimer une fois la migration admin validée.
 *
 * Indique uniquement si chaque variable attendue est définie (true/false) et sa longueur,
 * jamais sa valeur. Sert à distinguer "variable absente" de "variable présente mais
 * différente" sans avoir à deviner.
 */
export const config = { runtime: "edge" };

const EXPECTED = [
  "QUICK_ADD_SECRET",
  "GIPHY_API_KEY",
  "VAPID_PRIVATE_KEY_JWK",
  "VAPID_SUBJECT",
  "CRON_SECRET",
  "CF_ACCOUNT_ID",
  "CF_KV_NAMESPACE_ID",
  "CF_API_TOKEN",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
];

export default async function handler() {
  const report = {};
  for (const name of EXPECTED) {
    const value = process.env[name];
    report[name] = value ? { defined: true, length: value.length } : { defined: false };
  }
  return new Response(JSON.stringify(report, null, 2), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
