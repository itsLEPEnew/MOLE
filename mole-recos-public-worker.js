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
 * Pourquoi Deezer en repli PARTOUT (pas juste les tracklists) : constaté en test qu'Apple
 * peut bloquer/vider ses réponses de façon durable depuis les IP partagées de Cloudflare
 * (probablement leur détection anti-abus, indépendante du User-Agent). Deezer, lui, n'a
 * jamais failli en test. Chaque fonction Deezer ci-dessous renvoie donc ses résultats
 * NORMALISÉS exactement dans la forme qu'iTunes aurait renvoyée (mêmes noms de champs :
 * collectionId/collectionName/artistId/artistName/artworkUrl100/releaseDate) — index.html
 * n'a besoin de savoir laquelle des deux sources a répondu, ni d'être modifié pour ça. Les
 * ids Deezer sont préfixés "deezer-" pour rester des clés opaques distinctes des ids iTunes.
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
// un résultat vide (des deux sources) n'est pas forcément définitif -> TTL court pour
// retenter bientôt plutôt que figer un faux "aucun résultat" pendant des heures
const MISS_TTL = 60 * 5;

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

// ---------- recherche (artistes/albums) : iTunes d'abord, Deezer en repli ----------
async function handleAppleSearch(url, env) {
  const term = (url.searchParams.get("term") || "").trim();
  const entity = url.searchParams.get("entity") || "album";
  const limit = url.searchParams.get("limit") || "12";
  if (!term) return jsonResponse({ results: [] });

  const cacheKey = `cache:search:${entity}:${limit}:${term.toLowerCase()}`;
  const cached = await env.RECOS_KV.get(cacheKey);
  if (cached !== null) return jsonResponse(JSON.parse(cached));

  let data = await fetchItunesJsonWithRetry(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=${entity}&limit=${limit}`);

  if (!data.results || !data.results.length) {
    data = entity === "musicArtist"
      ? await deezerSearchArtist(term, limit)
      : await deezerSearchAlbum(term, limit);
  }

  await cachePut(env, cacheKey, data);
  return jsonResponse(data);
}

// ---------- discographie d'un artiste (lookup par id) : iTunes d'abord, Deezer en repli
// (par nom si l'id venait d'iTunes, directement par id s'il vient déjà de Deezer) ----------
async function handleAppleLookup(url, env) {
  const id = url.searchParams.get("id") || "";
  const entity = url.searchParams.get("entity") || "";
  const limit = url.searchParams.get("limit") || "";
  const name = url.searchParams.get("name") || "";
  if (!id) return jsonResponse({ results: [] });

  const cacheKey = `cache:lookup:${entity}:${id}`;
  const cached = await env.RECOS_KV.get(cacheKey);
  if (cached !== null) return jsonResponse(JSON.parse(cached));

  let data;
  if (id.startsWith("deezer-")) {
    data = await deezerArtistAlbums(id.slice(7), limit);
  } else {
    const qs = (entity ? `&entity=${entity}` : "") + (limit ? `&limit=${limit}` : "");
    data = await fetchItunesJsonWithRetry(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}${qs}`);
    if ((!data.results || !data.results.length) && entity === "album" && name) {
      data = await deezerSearchArtistThenAlbums(name, limit);
    }
  }

  await cachePut(env, cacheKey, data);
  return jsonResponse(data);
}

async function cachePut(env, cacheKey, data) {
  const ttl = (data.results && data.results.length) ? CACHE_TTL : MISS_TTL;
  await env.RECOS_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: ttl });
}

// 2 tentatives avec une courte pause : un blocage/rate-limit Apple peut être transitoire
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

// ---------- tracklist d'un album : iTunes d'abord (sauf id déjà Deezer), Deezer en repli
// sinon -> toujours renvoyé sous la même forme normalisée {position, recordingId, title,
// duration}, peu importe la source ----------
async function handleTracklist(url, env) {
  const collectionId = url.searchParams.get("collectionId") || "";
  const artist = url.searchParams.get("artist") || "";
  const title = url.searchParams.get("title") || "";
  if (!collectionId) return jsonResponse({ source: null, tracks: [] });

  const cacheKey = `cache:tracklist:${collectionId}`;
  const cached = await env.RECOS_KV.get(cacheKey);
  if (cached !== null) return jsonResponse(JSON.parse(cached));

  let tracks = [];
  let source = null;

  if (collectionId.startsWith("deezer-")) {
    tracks = await deezerAlbumTracksById(collectionId.slice(7));
    if (tracks.length) source = "deezer";
  } else {
    const data = await fetchItunesJsonWithRetry(`https://itunes.apple.com/lookup?id=${encodeURIComponent(collectionId)}&entity=song`);
    tracks = (data.results || [])
      .filter(r => r.wrapperType === "track")
      .map(t => ({ position: t.trackNumber, recordingId: t.trackId, title: t.trackName, duration: t.trackTimeMillis }));
    if (tracks.length) source = "itunes";

    if (!tracks.length && artist && title) {
      tracks = await fetchDeezerTracklistByName(artist, title);
      if (tracks.length) source = "deezer";
    }
  }

  const result = { source, tracks };
  await env.RECOS_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: tracks.length ? CACHE_TTL : MISS_TTL });
  return jsonResponse(result);
}

// ---------- repli Deezer : normalisation dans la forme iTunes (mêmes noms de champs) ----------
function deezerAlbumToItunesShape(a) {
  const suffix = a.record_type === "single" ? " - Single" : a.record_type === "ep" ? " - EP" : "";
  return {
    wrapperType: "collection",
    collectionType: "Album",
    collectionId: `deezer-${a.id}`,
    collectionName: (a.title || "") + suffix,
    artistId: a.artist ? `deezer-${a.artist.id}` : null,
    artistName: a.artist ? a.artist.name : "",
    artworkUrl100: a.cover_big || a.cover_medium || a.cover || null,
    releaseDate: a.release_date || null,
  };
}

async function deezerSearchAlbum(term, limit) {
  try {
    const res = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(term)}&limit=${limit}`);
    const data = await res.json();
    return { results: (data.data || []).map(deezerAlbumToItunesShape) };
  } catch (e) { return { results: [] }; }
}

async function deezerSearchArtist(term, limit) {
  try {
    const res = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(term)}&limit=${limit}`);
    const data = await res.json();
    return {
      results: (data.data || []).map(a => ({
        wrapperType: "artist", artistType: "Artist", artistName: a.name, artistId: `deezer-${a.id}`,
      })),
    };
  } catch (e) { return { results: [] }; }
}

async function deezerArtistAlbums(deezerArtistId, limit) {
  try {
    const res = await fetch(`https://api.deezer.com/artist/${deezerArtistId}/albums?limit=${limit || 200}`);
    const data = await res.json();
    return { results: (data.data || []).map(deezerAlbumToItunesShape) };
  } catch (e) { return { results: [] }; }
}

async function deezerSearchArtistThenAlbums(name, limit) {
  try {
    const res = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=1`);
    const data = await res.json();
    const best = data.data && data.data[0];
    if (!best) return { results: [] };
    return await deezerArtistAlbums(best.id, limit);
  } catch (e) { return { results: [] }; }
}

async function deezerAlbumTracksById(deezerAlbumId) {
  try {
    const res = await fetch(`https://api.deezer.com/album/${deezerAlbumId}`);
    const data = await res.json();
    return ((data.tracks && data.tracks.data) || []).map(t => ({
      position: t.track_position, recordingId: `deezer-${t.id}`, title: t.title, duration: (t.duration || 0) * 1000,
    }));
  } catch (e) { return []; }
}

async function fetchDeezerTracklistByName(artist, title) {
  try {
    const searchRes = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(artist + " " + title)}`);
    const searchData = await searchRes.json();
    const best = searchData.data && searchData.data[0];
    if (!best) return [];
    return await deezerAlbumTracksById(best.id);
  } catch (e) { return []; }
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
