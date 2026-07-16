/**
 * Proxy Last.fm gratuit — à déployer plus tard, quand le site sera en ligne.
 *
 * Pourquoi ce fichier existe :
 * L'API Last.fm (ws.audioscrobbler.com) ne renvoie pas d'en-tête CORS,
 * donc un site web ne peut pas l'appeler directement en JavaScript depuis
 * le navigateur (ça marche en local/serveur, pas depuis une page web).
 * Ce petit script tourne comme "Cloudflare Worker" (hébergement gratuit,
 * pas de carte bancaire requise pour le tier gratuit) et sert de pont :
 * ton site appelle CE worker, qui lui-même appelle Last.fm côté serveur
 * et renvoie la réponse avec les bons en-têtes CORS.
 *
 * Déploiement (gratuit, ~5 minutes) :
 * 1. Crée un compte sur https://dash.cloudflare.com (gratuit)
 * 2. Workers & Pages > Create > Create Worker
 * 3. Colle ce code, remplace LASTFM_API_KEY par ta clé (gratuite sur
 *    https://www.last.fm/api/account/create)
 * 4. Déploie, tu obtiens une URL du style https://tonworker.ton-compte.workers.dev
 * 5. Depuis le site, appelle par exemple :
 *    fetch("https://tonworker.ton-compte.workers.dev/?method=user.gettopartists&user=PSEUDO&period=6month")
 */

const LASTFM_API_KEY = "REMPLACE_PAR_TA_CLE_GRATUITE";
const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";

export default {
  async fetch(request) {
    const incoming = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const target = new URL(LASTFM_BASE);
    // on relaie tous les paramètres reçus (method, user, period, etc.)
    incoming.searchParams.forEach((value, key) => {
      target.searchParams.set(key, value);
    });
    target.searchParams.set("api_key", LASTFM_API_KEY);
    target.searchParams.set("format", "json");

    const lastfmResponse = await fetch(target.toString());
    const body = await lastfmResponse.text();

    return new Response(body, {
      status: lastfmResponse.status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(),
      },
    });
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
