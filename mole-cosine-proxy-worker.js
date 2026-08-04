/**
 * Proxy gratuit pour "La Piste" (sons similaires à partir de tes bangers) — à déployer sur
 * Cloudflare Workers (gratuit), même principe que mole-chat-proxy-worker.js.
 *
 * Pourquoi ce fichier existe :
 * L'API cosine.club (recherche par similarité audio réelle, pas par tags) demande une clé.
 * MOLE est un site 100% statique sans serveur : si on mettait la clé directement dans le
 * code, n'importe qui pourrait la voler en ouvrant le code source du site déployé. Ce petit
 * script tourne côté serveur (gratuit sur Cloudflare Workers), garde la clé secrète, et sert
 * de pont entre le site et l'API cosine.club.
 *
 * Déploiement (gratuit, ~5 minutes) :
 * 1. Crée un compte gratuit sur https://cosine.club, puis génère ta clé API sur
 *    https://cosine.club/account/api
 * 2. Va sur https://dash.cloudflare.com (tu as déjà un compte, utilisé pour mole-chat)
 * 3. Workers & Pages > Create > Create Worker
 * 4. Colle ce code, remplace COSINE_API_KEY par ta clé
 * 5. Déploie, tu obtiens une URL du style https://mole-cosine.ton-compte.workers.dev
 * 6. Colle cette URL dans COSINE_PROXY_URL en haut du <script> de index.html
 */

const COSINE_API_KEY = "REMPLACE_PAR_TA_CLE_GRATUITE";
const COSINE_BASE = "https://cosine.club/api/v1";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/search" && request.method === "GET") {
        const q = url.searchParams.get("q") || "";
        const limit = url.searchParams.get("limit") || "8";
        const upstream = await fetch(
          `${COSINE_BASE}/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`,
          { headers: cosineHeaders() }
        );
        return relay(upstream);
      }

      if (url.pathname === "/bulk" && request.method === "POST") {
        const body = await request.text();
        const upstream = await fetch(`${COSINE_BASE}/search/bulk`, {
          method: "POST",
          headers: { ...cosineHeaders(), "Content-Type": "application/json" },
          body,
        });
        return relay(upstream);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (e) {
      return jsonResponse({ error: "Impossible de contacter cosine.club" }, 502);
    }
  },
};

function cosineHeaders() {
  return {
    Authorization: `Bearer ${COSINE_API_KEY}`,
    "User-Agent": "mole-app/1.0 (https://itslepenew.github.io/MOLE/)",
  };
}

async function relay(upstreamRes) {
  const text = await upstreamRes.text();
  return new Response(text, {
    status: upstreamRes.status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
