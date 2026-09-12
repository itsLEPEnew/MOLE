/**
 * Logique métier du "Worker public" — recherche/covers/tracklists (iTunes, avec repli
 * Deezer) et lecture du mur. Port fidèle de mole-recos-public-worker.js vers Vercel : même
 * comportement, seul le stockage change.
 *
 * Deux backends distincts derrière le même genre d'appel : le cache de recherche
 * (kvGet/kvPut, clés "cache:...") reste sur Cloudflare KV — TTL courte, aucun intérêt à
 * le mettre en base. Le mur publié ("wall") vit depuis la migration Supabase dans
 * lib/supabase-db.js, comme la file d'attente et les abonnements push côté admin.
 */
import { kvGet, kvPut } from "./cloudflare-kv.js";
import { supaKvGet } from "./supabase-db.js";

const CACHE_TTL = 60 * 60 * 24 * 30; // 30 jours : les métadonnées d'un album ne changent quasi jamais
const MISS_TTL = 60 * 5; // un résultat vide n'est pas forcément définitif -> retente bientôt

const ITUNES_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Accept-Language": "en-US,en;q=0.9",
};

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function handleWall() {
  const raw = await supaKvGet("wall");
  const wall = raw ? JSON.parse(raw) : [];
  return jsonResponse({ wall });
}

export async function handleAppleSearch(url) {
  const term = (url.searchParams.get("term") || "").trim();
  const entity = url.searchParams.get("entity") || "album";
  const limit = url.searchParams.get("limit") || "12";
  if (!term) return jsonResponse({ results: [] });

  const cacheKey = `cache:search:${entity}:${limit}:${term.toLowerCase()}`;
  const cached = await kvGet(cacheKey);
  if (cached !== null) return jsonResponse(JSON.parse(cached));

  let data = await fetchItunesJsonWithRetry(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=${entity}&limit=${limit}`);

  if (!data.results || !data.results.length) {
    data = entity === "musicArtist"
      ? await deezerSearchArtist(term, limit)
      : await deezerSearchAlbum(term, limit);
  }

  await cachePut(cacheKey, data);
  return jsonResponse(data);
}

export async function handleAppleLookup(url) {
  const id = url.searchParams.get("id") || "";
  const entity = url.searchParams.get("entity") || "";
  const limit = url.searchParams.get("limit") || "";
  const name = url.searchParams.get("name") || "";
  if (!id) return jsonResponse({ results: [] });

  const cacheKey = `cache:lookup:${entity}:${id}`;
  const cached = await kvGet(cacheKey);
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

  await cachePut(cacheKey, data);
  return jsonResponse(data);
}

export async function handleTracklist(url) {
  const collectionId = url.searchParams.get("collectionId") || "";
  const artist = url.searchParams.get("artist") || "";
  const title = url.searchParams.get("title") || "";
  if (!collectionId) return jsonResponse({ source: null, tracks: [] });

  const cacheKey = `cache:tracklist:${collectionId}`;
  const cached = await kvGet(cacheKey);
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
  await kvPut(cacheKey, JSON.stringify(result), tracks.length ? CACHE_TTL : MISS_TTL);
  return jsonResponse(result);
}

async function cachePut(cacheKey, data) {
  const ttl = (data.results && data.results.length) ? CACHE_TTL : MISS_TTL;
  await kvPut(cacheKey, JSON.stringify(data), ttl);
}

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
