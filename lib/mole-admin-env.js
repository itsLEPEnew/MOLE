/**
 * Objet "env" de substitution pour le code admin porté depuis Cloudflare Workers.
 *
 * Le code de lib/mole-admin-core.js est une copie fidèle du Worker : il attend un objet
 * `env` avec les variables secrètes ET un binding `RECOS_KV` exposant .get()/.put().
 * Plutôt que de réécrire les ~25 endroits qui utilisent `env`, on reconstruit ici un objet
 * de la même forme.
 *
 * RECOS_KV pointait à l'origine sur Cloudflare KV (lib/cloudflare-kv.js) pour tout. Depuis
 * la migration Supabase, il ne pointe plus là que pour la MIGRATION elle-même (lire les
 * anciennes valeurs, voir la route temporaire /migrate-to-supabase dans mole-admin-core.js)
 * — en usage normal, "queue"/"wall"/"push_subscriptions" vivent dans Supabase
 * (lib/supabase-db.js), qui a le même contrat .get()/.put() qu'avant.
 *
 * Variables à définir dans Vercel (Settings > Environment Variables) :
 *   QUICK_ADD_SECRET       — sert à la fois de mot de passe admin, de valeur du cookie de
 *                            session, et de clé dans l'URL du raccourci iOS (/admin/quick?key=…)
 *   GIPHY_API_KEY          — recherche de GIF dans le tableau de bord
 *   VAPID_PRIVATE_KEY_JWK  — clé privée des notifications push (le JSON généré)
 *   VAPID_SUBJECT          — mailto:ton-email, exigé par le protocole Web Push
 *   SPOTIFY_CLIENT_ID      — optionnel : sans lui, la recherche Spotify se désactive d'elle-même
 *   SPOTIFY_CLIENT_SECRET  — optionnel, idem
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY — voir lib/supabase-db.js
 * (plus CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID / CF_API_TOKEN, toujours utilisées pour le
 * cache de recherche — lib/mole-public-core.js — et pour lire les anciennes données lors
 * de la migration.)
 */
import { supaKvGet, supaKvPut } from "./supabase-db.js";

export function buildAdminEnv() {
  return {
    QUICK_ADD_SECRET: process.env.QUICK_ADD_SECRET,
    GIPHY_API_KEY: process.env.GIPHY_API_KEY,
    VAPID_PRIVATE_KEY_JWK: process.env.VAPID_PRIVATE_KEY_JWK,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
    RECOS_KV: {
      get: (key) => supaKvGet(key),
      put: (key, value) => supaKvPut(key, value),
    },
  };
}
