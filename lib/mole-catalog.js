/**
 * Catalogue MOLE — notre propre base de musique, dans Supabase.
 *
 * Avant : chaque recherche interrogeait Deezer en direct. Résultat, ~400 ms au mieux, et une
 * tracklist qui repartait chercher ses titres à chaque ouverture de fiche ("chargement en
 * cours"). Maintenant : on interroge NOTRE base (~110 ms de travail serveur, mesuré, contre
 * ~400 ms via Deezer), et tout ce qu'on découvre y est
 * écrit DÉFINITIVEMENT — pas un cache qui expire. Le catalogue s'enrichit donc de ce que la
 * communauté cherche vraiment, et devient de plus en plus complet sans effort.
 *
 * Deezer reste la source, mais n'est plus dans le chemin critique :
 *   - recherche trouvée en base  -> réponse immédiate, aucun appel externe
 *   - recherche absente          -> on va chercher chez Deezer, on répond, ET on écrit en base
 *   - job quotidien (cron)       -> pré-charge les nouveautés des artistes déjà connus
 * Une sortie du soir même est donc trouvable le soir même : le premier qui la cherche paie
 * l'aller-retour, tous les suivants l'ont instantanément.
 *
 * Un point important sur les tracklists : l'appel Deezer album/{id} renvoie DÉJÀ les titres
 * en même temps que la date de sortie. On les jetait. On les stocke désormais avec l'album,
 * donc l'ouverture d'une fiche n'entraîne plus aucun appel réseau.
 */

const SUPA_TABLE_ARTISTS = "catalog_artists";
const SUPA_TABLE_ALBUMS = "catalog_albums";

function restUrl(path) {
  const base = process.env.SUPABASE_URL || "REMPLACE_PAR_TON_PROJECT_URL";
  return `${base.replace(/\/$/, "")}/rest/v1/${path}`;
}

function authHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY || "REMPLACE_PAR_TA_CLE_SECRETE";
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function supaSelect(path) {
  const res = await fetch(restUrl(path), { headers: authHeaders() });
  if (!res.ok) throw new Error(`catalogue SELECT (${res.status}) : ${await res.text()}`);
  return res.json();
}

// upsert : on réécrit par-dessus si l'entrée existe déjà (métadonnées rafraîchies), sinon on
// insère. "resolution=merge-duplicates" est la façon PostgREST de faire un ON CONFLICT.
async function supaUpsert(table, rows) {
  if (!rows.length) return;
  const res = await fetch(restUrl(table), {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`catalogue UPSERT ${table} (${res.status}) : ${await res.text()}`);
}

// Même normalisation que côté recherche : minuscules, sans accents, ponctuation réduite à des
// espaces. C'est cette forme qu'on stocke ET qu'on interroge, pour que "Motörhead" réponde à
// "motorhead" et "Sigur Rós" à "sigur ros".
export function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// PostgREST attend les jokers sous forme "*" dans un ilike, et les virgules/parenthèses
// casseraient la syntaxe des filtres -> on les retire du motif.
function ilikePattern(q) {
  return "*" + normalizeText(q).replace(/[(),*]/g, " ").trim() + "*";
}

// ---------- écriture (ingestion) ----------

function artistRowFromDeezer(a) {
  return {
    id: `deezer-${a.id}`,
    name: a.name || "",
    name_norm: normalizeText(a.name),
    // Deezer renvoie une URL même quand l'artiste n'a pas de photo : l'empreinte est vide,
    // ce qui donne ".../artist//500x500-..." et afficherait un carré vide
    picture: (a.picture_big || a.picture_medium || a.picture || "").includes("/artist//")
      ? null
      : (a.picture_big || a.picture_medium || a.picture || null),
    nb_fan: a.nb_fan || 0,
    updated_at: new Date().toISOString(),
  };
}

function albumRowFromDeezer(al, tracks) {
  const artist = al.artist || {};
  return {
    id: `deezer-${al.id}`,
    title: al.title || "",
    title_norm: normalizeText(al.title),
    artist_id: artist.id ? `deezer-${artist.id}` : null,
    artist_name: artist.name || "",
    artist_name_norm: normalizeText(artist.name),
    record_type: al.record_type || null,
    release_date: al.release_date || null,
    cover: al.cover_big || al.cover_medium || al.cover || null,
    nb_tracks: al.nb_tracks || (tracks ? tracks.length : null),
    tracklist: tracks || [],
    rank: al.fans || 0,
    updated_at: new Date().toISOString(),
  };
}

// On ne garde que ce qui sert à l'affichage : une tracklist complète de 30 titres en JSON brut
// pèserait inutilement lourd en base, multiplié par des dizaines de milliers d'albums.
function slimTracks(tracksData) {
  return (tracksData || []).map((t, i) => ({
    position: i + 1,
    title: t.title || "",
    duration: t.duration || 0,
    preview: t.preview || null, // extrait de 30 s fourni par Deezer
  }));
}

/**
 * Récupère le détail complet d'un album chez Deezer (date, type, ET tracklist en une requête)
 * et le range en base. C'est l'appel qu'on faisait déjà pour la seule date de sortie.
 */
export async function ingestAlbumById(deezerAlbumId) {
  const res = await fetch(`https://api.deezer.com/album/${deezerAlbumId}`);
  if (!res.ok) return null;
  const al = await res.json();
  if (!al || al.error) return null;

  let tracks = slimTracks(al.tracks && al.tracks.data);
  // sécurité : sur les albums très longs, Deezer peut paginer les titres inclus
  if (al.nb_tracks && tracks.length && tracks.length < al.nb_tracks) {
    try {
      const more = await (await fetch(`https://api.deezer.com/album/${deezerAlbumId}/tracks?limit=300`)).json();
      if (more && more.data && more.data.length > tracks.length) tracks = slimTracks(more.data);
    } catch (e) { /* on garde ce qu'on a */ }
  }

  const row = albumRowFromDeezer(al, tracks);
  await supaUpsert(SUPA_TABLE_ALBUMS, [row]);
  if (al.artist && al.artist.id) {
    await supaUpsert(SUPA_TABLE_ARTISTS, [artistRowFromDeezer(al.artist)]).catch(() => {});
  }
  return row;
}

/**
 * Ingère des albums à partir de leurs DÉTAILS Deezer déjà récupérés (album/{id}).
 * Important : ne refait aucun appel réseau. handleAppleSearch récupère déjà ces détails pour
 * en extraire les dates de sortie — les redemander ici doublait le coût de chaque première
 * recherche pour rien.
 */
export async function ingestAlbumDetails(details) {
  const rows = [];
  const artistRows = new Map();
  for (const al of details) {
    if (!al || al.error) continue;
    rows.push(albumRowFromDeezer(al, slimTracks(al.tracks && al.tracks.data)));
    if (al.artist && al.artist.id) {
      artistRows.set(al.artist.id, artistRowFromDeezer(al.artist));
    }
  }
  if (rows.length) await supaUpsert(SUPA_TABLE_ALBUMS, rows);
  if (artistRows.size) await supaUpsert(SUPA_TABLE_ARTISTS, [...artistRows.values()]).catch(() => {});
  return rows;
}

/** Variante qui va chercher les détails elle-même (utilisée par le job quotidien). */
export async function ingestAlbums(deezerAlbums) {
  const details = await Promise.all(
    deezerAlbums.map(a =>
      fetch(`https://api.deezer.com/album/${a.id}`).then(r => r.json()).catch(() => null))
  );
  return ingestAlbumDetails(details);
}

export async function ingestArtists(deezerArtists) {
  const rows = deezerArtists.map(artistRowFromDeezer);
  if (rows.length) await supaUpsert(SUPA_TABLE_ARTISTS, rows);
  return rows;
}

// ---------- lecture (recherche) ----------

export async function searchCatalogArtists(term, limit = 12) {
  const pattern = ilikePattern(term);
  if (pattern.length <= 2) return [];
  return supaSelect(
    `${SUPA_TABLE_ARTISTS}?name_norm=ilike.${encodeURIComponent(pattern)}` +
    `&order=nb_fan.desc&limit=${limit * 3}`);
}

export async function searchCatalogAlbums(term, limit = 12) {
  const pattern = ilikePattern(term);
  if (pattern.length <= 2) return [];
  // un album compte s'il correspond par son titre OU par le nom de son artiste
  const filter = `or=(title_norm.ilike.${pattern},artist_name_norm.ilike.${pattern})`;
  return supaSelect(
    `${SUPA_TABLE_ALBUMS}?${encodeURI(filter)}&order=rank.desc&limit=${limit * 3}`);
}

/** Tracklist déjà stockée, s'il y en a une. Aucun appel réseau. */
export async function getCatalogTracklist(albumId) {
  const rows = await supaSelect(
    `${SUPA_TABLE_ALBUMS}?id=eq.${encodeURIComponent(albumId)}&select=tracklist&limit=1`);
  const tl = rows[0] && rows[0].tracklist;
  return Array.isArray(tl) && tl.length ? tl : null;
}

/** Artistes déjà connus, pour que le job quotidien sache chez qui aller chercher du neuf. */
export async function listKnownArtists(limit = 200) {
  return supaSelect(
    `${SUPA_TABLE_ARTISTS}?select=id,name,discography_synced_at` +
    `&order=discography_synced_at.asc.nullsfirst&limit=${limit}`);
}

export async function markArtistSynced(artistId) {
  await fetch(restUrl(`${SUPA_TABLE_ARTISTS}?id=eq.${encodeURIComponent(artistId)}`), {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify({ discography_synced_at: new Date().toISOString() }),
  });
}
