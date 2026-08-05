/**
 * Worker public "Recos de la taupe" — sert uniquement le mur déjà publié.
 * Aucune protection nécessaire ici : c'est fait pour être lu par n'importe qui
 * qui visite MOLE. La partie privée (ajout/édition/publication) vit dans
 * mole-recos-admin-worker.js, protégée par Cloudflare Access.
 *
 * Déploiement (~5 minutes) :
 * 1. Sur https://dash.cloudflare.com : Workers & Pages > Create application >
 *    Start with Hello World!
 * 2. AVANT de coller ce code : crée le stockage partagé une seule fois.
 *    Workers & Pages > KV > Create a namespace, appelle-le par exemple
 *    "mole_recos" (le nom exact n'a pas d'importance).
 * 3. Sur CE Worker : Settings > Bindings > Add > KV Namespace.
 *    Variable name : RECOS_KV (exactement ce nom, en majuscules).
 *    KV namespace : choisis "mole_recos" créé à l'étape 2.
 * 4. Colle ce code (bouton "Edit code"), déploie.
 * 5. Refais EXACTEMENT la même liaison KV (variable RECOS_KV -> mole_recos)
 *    sur mole-recos-admin-worker.js une fois qu'il est créé, pour que les
 *    deux Workers partagent le même stockage.
 * 6. Note l'URL obtenue (https://xxx.ton-compte.workers.dev) — c'est celle-ci
 *    que MOLE ira lire pour afficher le mur.
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);

    if (url.pathname === "/wall" && request.method === "GET") {
      const raw = await env.RECOS_KV.get("wall");
      const wall = raw ? JSON.parse(raw) : [];
      return jsonResponse({ wall });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
