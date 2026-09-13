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
import {
  searchCatalogArtists, searchCatalogAlbums, getCatalogTracklist,
  ingestAlbumDetails, ingestArtists,
} from "./mole-catalog.js";

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

// En dessous de ce nombre de résultats trouvés en base, on considère qu'on ne connaît pas
// encore assez le sujet et on va voir chez Deezer. Le système se corrige de lui-même : ce
// passage ingère une douzaine d'albums, donc la même recherche répondra ensuite en local.
const LOCAL_ENOUGH = 8;

// Le catalogue stocke ses propres colonnes ; le client, lui, attend depuis toujours la forme
// iTunes (collectionId, artworkUrl100...). On traduit ici plutôt que de toucher au client.
function catalogAlbumToItunesShape(row) {
  const suffix = row.record_type === "single" ? " - Single" : row.record_type === "ep" ? " - EP" : "";
  return {
    wrapperType: "collection",
    collectionType: "Album",
    collectionId: row.id,
    collectionName: (row.title || "") + suffix,
    artistId: row.artist_id,
    artistName: row.artist_name || "",
    artworkUrl100: row.cover || null,
    releaseDate: row.release_date || null,
  };
}

function catalogArtistToItunesShape(row) {
  return {
    wrapperType: "artist",
    artistType: "Artist",
    artistName: row.name,
    artistId: row.id,
    artworkUrl100: row.picture || null,
    nbFan: row.nb_fan || 0,
  };
}

export async function handleAppleSearch(url) {
  const term = (url.searchParams.get("term") || "").trim();
  const entity = url.searchParams.get("entity") || "album";
  const limit = parseInt(url.searchParams.get("limit") || "12", 10);
  if (!term) return jsonResponse({ results: [] });

  // 1) NOTRE catalogue d'abord. C'est tout l'objet de l'étape 2 : ne plus dépendre d'une API
  // externe dans le chemin critique. Ce qu'on a déjà rencontré répond sans sortir du réseau.
  try {
    if (entity === "musicArtist") {
      const rows = await searchCatalogArtists(term, limit);
      if (rows.length >= LOCAL_ENOUGH) {
        const ranked = rankArtists(
          rows.map(r => ({ id: r.id.replace("deezer-", ""), name: r.name, nb_fan: r.nb_fan, _row: r })), term);
        return jsonResponse({ results: ranked.slice(0, limit).map(a => catalogArtistToItunesShape(a._row)), source: "catalogue" });
      }
    } else {
      const rows = await searchCatalogAlbums(term, limit);
      if (rows.length >= LOCAL_ENOUGH) {
        return jsonResponse({ results: rows.slice(0, limit).map(catalogAlbumToItunesShape), source: "catalogue" });
      }
    }
  } catch (e) { /* catalogue indisponible -> on continue vers Deezer, rien n'est bloqué */ }

  // 2) Sinon Deezer (iTunes ne fait pas remonter les nouveautés : chercher "Nothing But
  // Thieves" y renvoyait 2015-2018 sans l'album sorti la veille), iTunes en dernier recours.
  const raw = entity === "musicArtist"
    ? await deezerRawArtists(term, limit)
    : await deezerRawAlbums(term, limit);

  let data = entity === "musicArtist"
    ? { results: rankArtists(raw, term).map(a => ({
        wrapperType: "artist", artistType: "Artist", artistName: a.name, artistId: `deezer-${a.id}`,
        artworkUrl100: deezerPictureOrNull(a.picture_big || a.picture_medium || a.picture),
        nbFan: a.nb_fan || 0,
      })) }
    : null;

  // un seul aller-retour par album, réutilisé pour la réponse ET pour l'ingestion
  let albumDetails = null;
  if (entity !== "musicArtist") {
    albumDetails = await deezerAlbumDetails(raw);
    raw.forEach((a, i) => {
      if (albumDetails[i] && albumDetails[i].release_date) a.release_date = albumDetails[i].release_date;
    });
    data = { results: raw.map(deezerAlbumToItunesShape) };
  }

  if (!data.results.length) {
    data = await fetchItunesJsonWithRetry(
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=${entity}&limit=${limit}`);
  }

  // 3) On écrit ce qu'on vient de découvrir — définitivement, pas dans un cache qui expire.
  // C'est ce qui fait grossir le catalogue au rythme de ce que la communauté cherche.
  try {
    if (entity === "musicArtist") await ingestArtists(raw);
    else if (albumDetails && albumDetails.length) await ingestAlbumDetails(albumDetails);
  } catch (e) { /* une ingestion ratée ne doit jamais empêcher de répondre */ }

  return jsonResponse({ ...data, source: "deezer" });
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

// ---------- fiche artiste : bio (Wikipédia) + artistes associés ----------
// Ces deux informations n'existent que chez MusicBrainz, mais l'appeler depuis le navigateur
// de chaque visiteur ne tient pas : leur limite est d'UNE requête par seconde et par IP.
// Mesuré le 12/09/2026 depuis la page : 12 s de latence puis des 503 — la bio n'arrivait
// jamais. Ici, côté serveur et avec le cache KV, on ne les interroge qu'une fois par artiste,
// et en une seule requête (url-rels ET artist-rels ensemble) au lieu des deux d'avant.
const MB_HEADERS = {
  Accept: "application/json",
  // MusicBrainz exige un User-Agent identifiant l'application, sous peine de blocage
  "User-Agent": "MOLE/1.0 (https://mole-mole4.vercel.app)",
};

// Wikimedia impose un User-Agent identifiant et bloque les clients anonymes — leur API
// Action (utilisée par la branche Wikidata) est la plus stricte là-dessus. Sans ça, un artiste
// sans lien Wikipédia direct, comme Radiohead, ne récupérait jamais sa bio depuis Vercel alors
// que la même chaîne fonctionnait depuis une machine de dev.
const WIKI_HEADERS = { "User-Agent": "MOLE/1.0 (https://mole-mole4.vercel.app)" };

const RELATION_LABELS = {
  "member of band": "Membre de",
  "founder": "Fondateur de",
  "collaboration": "Collaboration",
  "remixer": "Remix",
  "composer": "Compositeur",
  "conductor": "Chef d'orchestre",
  "is person": "Alias de",
  "voice actor": "Voix",
};


// MusicBrainz plafonne à UNE requête par seconde et par IP, et répond 503 au-delà. Comme on
// enchaîne deux appels (recherche du nom, puis détail), même une seule fiche peut le
// déclencher — vérifié le 13/09 : deux requêtes rapprochées donnent 200 puis 503, espacées
// de 1,5 s elles passent toutes les deux. On attend donc et on réessaie, ce qui ne coûte que
// sur le premier accès à un artiste puisque le résultat part ensuite au cache.
async function mbFetch(apiUrl, attempt = 1) {
  const res = await fetch(apiUrl, { headers: MB_HEADERS });
  if ((res.status === 503 || res.status === 429) && attempt <= 2) {
    await new Promise(r => setTimeout(r, 1200 * attempt));
    return mbFetch(apiUrl, attempt + 1);
  }
  return res;
}
async function mbFindArtistIdByName(name) {
  const res = await mbFetch(
    `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(name)}&fmt=json&limit=5`);
  if (!res.ok) return null;
  const data = await res.json();
  const match = (data.artists || []).find(
    a => a.name.toLowerCase() === name.toLowerCase() && (a.score || 0) >= 60);
  return match ? match.id : null;
}

async function resolveWikiLangTitle(relations) {
  const wikiRel = relations.find(r => r.type === "wikipedia" && r.url && r.url.resource);
  if (wikiRel) {
    const u = new URL(wikiRel.url.resource);
    return { lang: u.hostname.split(".")[0], title: decodeURIComponent(u.pathname.replace(/^\/wiki\//, "")) };
  }
  const wikidataRel = relations.find(r => r.type === "wikidata" && r.url && r.url.resource);
  if (wikidataRel) {
    const qid = wikidataRel.url.resource.split("/").pop();
    const wdRes = await fetch(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&format=json`,
      { headers: WIKI_HEADERS });
    const wdData = await wdRes.json();
    const sitelinks = (wdData.entities && wdData.entities[qid] && wdData.entities[qid].sitelinks) || {};
    const preferred = sitelinks.frwiki || sitelinks.enwiki;
    if (preferred) return { lang: preferred.site.replace(/wiki$/, ""), title: preferred.title };
  }
  return { lang: null, title: null };
}

export async function handleArtistInfo(url) {
  const name = (url.searchParams.get("name") || "").trim();
  if (!name) return jsonResponse({ bio: null, image: null, related: [] });

  const cacheKey = `cache:artistinfo:v2:${name.toLowerCase()}`;
  const cached = await kvGet(cacheKey);
  if (cached !== null) return jsonResponse(JSON.parse(cached));

  const result = { bio: null, image: null, related: [] };
  try {
    const mbid = await mbFindArtistIdByName(name);
    if (mbid) {
      const res = await mbFetch(
        `https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels+artist-rels&fmt=json`);
      if (res.ok) {
        const data = await res.json();

        // isolé : une bio indisponible ne doit pas emporter les artistes associés avec elle,
        // qui sont extraits juste après et ne dépendent pas de Wikipédia
        try {
        const { lang, title } = await resolveWikiLangTitle(data.relations || []);
        if (lang && title) {
          const sumRes = await fetch(
            `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
            { headers: WIKI_HEADERS });
          if (sumRes.ok) {
            const sum = await sumRes.json();
            result.image = (sum.thumbnail && sum.thumbnail.source) || null;
            result.bio = sum.extract || null;
          }
        }
        } catch (e) { /* bio indisponible : on garde quand même les associés ci-dessous */ }

        const seen = new Map();
        (data.relations || []).forEach(r => {
          if (!r.artist || !r.artist.id || r.artist.id === mbid) return;
          if (seen.has(r.artist.id)) return;
          seen.set(r.artist.id, {
            id: r.artist.id, name: r.artist.name, label: RELATION_LABELS[r.type] || r.type,
          });
        });
        result.related = Array.from(seen.values()).slice(0, 12);
      }
    }
  } catch (e) { /* la fiche reste utilisable sans bio ni associés */ }

  // cachePut() déduit sa durée de data.results, absent ici -> on écrit nous-mêmes. Un résultat
  // vide est mis en cache brièvement : inutile de re-subir un 503 MusicBrainz à chaque
  // ouverture de fiche, tout en laissant une chance de réessayer bientôt.
  const ttl = (result.bio || result.related.length) ? CACHE_TTL : MISS_TTL;
  await kvPut(cacheKey, JSON.stringify(result), ttl);
  return jsonResponse(result);
}

export async function handleTracklist(url) {
  const collectionId = url.searchParams.get("collectionId") || "";
  const artist = url.searchParams.get("artist") || "";
  const title = url.searchParams.get("title") || "";
  if (!collectionId) return jsonResponse({ source: null, tracks: [] });

  // 1) la tracklist est-elle déjà rangée avec l'album dans le catalogue ? Depuis l'étape 2,
  // elle y est écrite AU MOMENT de l'ingestion (l'appel Deezer qui donne la date de sortie
  // contient déjà les titres, on les jetait). Dans ce cas : aucun appel réseau, donc plus de
  // message "chargement en cours" à l'ouverture d'une fiche.
  try {
    const stored = await getCatalogTracklist(collectionId);
    if (stored) {
      return jsonResponse({
        source: "catalogue",
        tracks: stored.map(t => ({ title: t.title, duration: t.duration, preview: t.preview || null })),
      });
    }
  } catch (e) { /* catalogue indisponible -> on retombe sur le chemin classique */ }

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

// search/album ne renvoie PAS release_date (contrairement à album/{id}). Sans date, l'app
// ne peut ni afficher l'année ni distinguer une nouveauté — on complète donc les résultats
// en parallèle. Mesuré : ~150 ms pour 12 albums, et payé une seule fois par terme puisque
// le résultat part ensuite au cache.
// Renvoie les détails complets (date, type, tracklist...) des albums passés. Un seul aller
// par album, dont le résultat sert DEUX fois : compléter la réponse au client, et alimenter
// le catalogue. Avant, chacun refaisait l'appel de son côté.
async function deezerAlbumDetails(albums) {
  return Promise.all(
    albums.map(a =>
      fetch(`https://api.deezer.com/album/${a.id}`).then(r => r.json()).catch(() => null))
  );
}

async function deezerEnrichReleaseDates(albums) {
  try {
    const details = await Promise.all(
      albums.map(a =>
        fetch(`https://api.deezer.com/album/${a.id}`)
          .then(r => r.json())
          .catch(() => null)
      )
    );
    albums.forEach((a, i) => {
      if (details[i] && details[i].release_date) a.release_date = details[i].release_date;
    });
  } catch (e) { /* sans date, le reste du résultat reste utilisable */ }
  return albums;
}

// Versions "brutes" : renvoient les objets Deezer tels quels. handleAppleSearch en a besoin
// pour deux usages à la fois — répondre au client (après mise en forme) ET alimenter le
// catalogue (qui veut les champs d'origine). Les versions mises en forme juste en dessous
// restent utilisées par les autres appelants (discographie, repli de lookup).
async function deezerRawAlbums(term, limit) {
  try {
    const res = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(term)}&limit=${limit}`);
    const data = await res.json();
    return data.data || [];
  } catch (e) { return []; }
}

async function deezerRawArtists(term, limit) {
  try {
    const res = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(term)}&limit=${limit}`);
    const data = await res.json();
    return data.data || [];
  } catch (e) { return []; }
}

async function deezerSearchAlbum(term, limit) {
  try {
    const res = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(term)}&limit=${limit}`);
    const data = await res.json();
    const albums = await deezerEnrichReleaseDates(data.data || []);
    return { results: albums.map(deezerAlbumToItunesShape) };
  } catch (e) { return { results: [] }; }
}

// Deezer ne trie pas par notoriété : sur "michael jackson" il place un homonyme à 175 fans
// devant celui à 13 millions, et renvoie des doublons exacts. On reclasse donc nous-mêmes —
// d'abord la qualité de correspondance du nom, ensuite le nombre de fans — et on fusionne
// les doublons en gardant l'entrée la plus suivie.
function normalizeArtistName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // accents
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function rankArtists(artists, term) {
  const q = normalizeArtistName(term);
  const byName = new Map();
  for (const a of artists) {
    const key = normalizeArtistName(a.name);
    const prev = byName.get(key);
    if (!prev || (a.nb_fan || 0) > (prev.nb_fan || 0)) byName.set(key, a);
  }
  return Array.from(byName.values())
    .map(a => {
      const n = normalizeArtistName(a.name);
      // paliers : la correspondance exacte prime toujours sur la notoriété, sinon un
      // inconnu très suivi passerait devant l'artiste réellement cherché
      const tier = n === q ? 3 : n.startsWith(q) ? 2 : n.includes(q) ? 1 : 0;
      return { a, score: tier * 1e12 + (a.nb_fan || 0) };
    })
    .sort((x, y) => y.score - x.score)
    .map(x => x.a);
}

// Deezer renvoie toujours une URL de photo, même pour un artiste qui n'en a pas : l'empreinte
// est alors vide, ce qui donne ".../images/artist//500x500-..." (double slash) et affiche un
// carré vide. Mieux vaut rendre null et laisser l'initiale s'afficher.
function deezerPictureOrNull(url) {
  if (!url || url.includes("/artist//")) return null;
  return url;
}

async function deezerSearchArtist(term, limit) {
  try {
    const res = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(term)}&limit=${limit}`);
    const data = await res.json();
    return {
      results: rankArtists(data.data || [], term).map(a => ({
        wrapperType: "artist", artistType: "Artist", artistName: a.name, artistId: `deezer-${a.id}`,
        // la photo vient avec le résultat : plus besoin de la chaîne MusicBrainz -> Wikipédia
        // pour afficher un avatar, il s'affiche immédiatement
        artworkUrl100: deezerPictureOrNull(a.picture_big || a.picture_medium || a.picture),
        nbFan: a.nb_fan || 0,
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
