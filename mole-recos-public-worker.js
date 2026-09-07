/**
 * Worker public "Recos de la taupe" — sert le mur déjà publié, et fait aussi office de
 * proxy-cache pour les recherches/covers/tracklists (iTunes, avec repli Deezer) utilisées
 * partout ailleurs dans index.html (recherche, discographie, page album). Aucune protection
 * nécessaire ici : c'est fait pour être lu par n'importe qui qui visite MOLE. La partie
 * privée (ajout/édition/publication) vit dans mole-recos-admin-worker.js, protégée par
 * Cloudflare Access.
 *
 * Pourquoi un proxy-cache : sans lui, chaque visiteur qui recherche "Daft Punk" retape
 * iTunes en direct depuis son navigateur, à chaque fois. Avec lui, la PREMIÈRE recherche
 * (n'importe quel visiteur) va chercher chez iTunes et stocke le résultat dans RECOS_KV ;
 * toutes les suivantes, pour n'importe qui, sont servies depuis KV en quelques ms — les
 * métadonnées d'un album ne changent quasi jamais, donc un cache long (30 jours) est sûr.
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
 *    que MOLE ira lire pour afficher le mur et pour la recherche/covers/tracklists.
 */

const CACHE_TTL = 60 * 60 * 24 * 30; // 30 jours : les métadonnées d'un album ne changent quasi jamais
// Apple bloque/vide parfois une réponse de façon TRANSITOIRE (pas systématique - constaté en
// test : la même requête échoue puis réussit quelques secondes après) depuis les IP partagées
// de Cloudflare -> un résultat vide n'est pas forcément définitif, TTL court pour retenter vite
// plutôt que figer un faux "aucun résultat" pendant des heures
const MISS_TTL = 60 * 5;

// Apple bloque/vide silencieusement certaines réponses (surtout entity=album) quand la requête
// vient des IP partagées de Cloudflare sans en-tête de navigateur -> même repli que
// mole-recos-admin-worker.js (fetchAppleTracklist) : se faire passer pour Safari desktop
const ITUNES_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Accept-Language": "en-US,en;q=0.9",
};

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

    if (url.pathname === "/apple/search" && request.method === "GET") {
      return handleAppleSearch(url, env);
    }

    if (url.pathname === "/apple/lookup" && request.method === "GET") {
      return handleAppleLookup(url, env);
    }

    if (url.pathname === "/apple/tracklist" && request.method === "GET") {
      return handleTracklist(url, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

// ---------- recherche/discographie : simple passe-plat iTunes, mis en cache tel quel ----------
async function handleAppleSearch(url, env) {
  const term = (url.searchParams.get("term") || "").trim();
  const entity = url.searchParams.get("entity") || "album";
  const limit = url.searchParams.get("limit") || "12";
  if (!term) return jsonResponse({ results: [] });
  const cacheKey = `cache:search:${entity}:${limit}:${term.toLowerCase()}`;
  const data = await cachedItunesFetch(env, cacheKey,
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=${entity}&limit=${limit}`);
  return jsonResponse(data);
}

async function handleAppleLookup(url, env) {
  const id = url.searchParams.get("id") || "";
  const entity = url.searchParams.get("entity") || "";
  const limit = url.searchParams.get("limit") || "";
  if (!id) return jsonResponse({ results: [] });
  const cacheKey = `cache:lookup:${entity}:${id}`;
  const qs = (entity ? `&entity=${entity}` : "") + (limit ? `&limit=${limit}` : "");
  const data = await cachedItunesFetch(env, cacheKey, `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}${qs}`);
  return jsonResponse(data);
}

// 2 tentatives avec une courte pause : un blocage/rate-limit Apple observé en test est
// transitoire, la même requête peut réussir quelques centaines de ms plus tard
async function fetchItunesJsonWithRetry(apiUrl, attempts = 2) {
  let data = { results: [] };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(apiUrl, { headers: ITUNES_HEADERS });
      data = await res.json();
      if (data.results && data.results.length) return data;
    } catch (e) { /* on retente */ }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 300));
  }
  return data;
}

async function cachedItunesFetch(env, cacheKey, apiUrl) {
  const cached = await env.RECOS_KV.get(cacheKey);
  if (cached !== null) return JSON.parse(cached);
  const data = await fetchItunesJsonWithRetry(apiUrl);
  const ttl = (data.results && data.results.length) ? CACHE_TTL : MISS_TTL;
  await env.RECOS_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: ttl });
  return data;
}

// ---------- tracklist d'un album : iTunes d'abord, Deezer en repli si iTunes n'a pas
// cette édition (import obscur, compilation, etc.) -> toujours renvoyé sous la même forme
// normalisée {position, recordingId, title, duration}, peu importe la source ----------
async function handleTracklist(url, env) {
  const collectionId = url.searchParams.get("collectionId") || "";
  const artist = url.searchParams.get("artist") || "";
  const title = url.searchParams.get("title") || "";
  if (!collectionId) return jsonResponse({ source: null, tracks: [] });

  const cacheKey = `cache:tracklist:${collectionId}`;
  const cached = await env.RECOS_KV.get(cacheKey);
  if (cached !== null) return jsonResponse(JSON.parse(cached));

  let tracks = [];
  let source = "itunes";
  const data = await fetchItunesJsonWithRetry(`https://itunes.apple.com/lookup?id=${encodeURIComponent(collectionId)}&entity=song`);
  tracks = (data.results || [])
    .filter(r => r.wrapperType === "track")
    .map(t => ({ position: t.trackNumber, recordingId: t.trackId, title: t.trackName, duration: t.trackTimeMillis }));

  if (!tracks.length && artist && title) {
    source = "deezer";
    tracks = await fetchDeezerTracklist(artist, title);
  }

  const result = { source: tracks.length ? source : null, tracks };
  await env.RECOS_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: tracks.length ? CACHE_TTL : MISS_TTL });
  return jsonResponse(result);
}

async function fetchDeezerTracklist(artist, title) {
  try {
    const searchRes = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(artist + " " + title)}`);
    const searchData = await searchRes.json();
    const best = searchData.data && searchData.data[0];
    if (!best) return [];
    const albumRes = await fetch(`https://api.deezer.com/album/${best.id}`);
    const albumData = await albumRes.json();
    return ((albumData.tracks && albumData.tracks.data) || []).map(t => ({
      position: t.track_position,
      recordingId: `deezer-${t.id}`,
      title: t.title,
      duration: (t.duration || 0) * 1000
    }));
  } catch (e) {
    return [];
  }
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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
