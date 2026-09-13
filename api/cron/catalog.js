/**
 * Job quotidien du catalogue : va chercher chez Deezer les sorties récentes des artistes
 * déjà connus de la base, et les range avec leur tracklist.
 *
 * À noter : ce job n'est PAS ce qui rend une nouveauté disponible. Une sortie du soir même est
 * déjà trouvable le soir même, parce qu'une recherche qui ne trouve rien en base interroge
 * Deezer et écrit le résultat au passage (voir handleAppleSearch). Ce job sert à ce que ce soit
 * déjà là AVANT que quiconque cherche — du confort, pas une condition d'accès. C'est important
 * car le forfait Vercel gratuit ne permet qu'une exécution par jour.
 *
 * Déclenché par Vercel via l'entrée "crons" de vercel.json, avec CRON_SECRET en en-tête
 * Authorization (même mécanisme que le job de publication du vendredi).
 */
import { listKnownArtists, markArtistSynced, ingestAlbums } from "../../lib/mole-catalog.js";

export const config = { runtime: "edge" };

// Plafond par exécution : une fonction edge a un temps d'exécution limité, et Deezer n'aime
// pas les rafales. Les artistes sont traités en commençant par ceux jamais synchronisés, puis
// par les plus anciens (voir listKnownArtists) -> tout le catalogue finit par tourner.
const MAX_ARTISTS_PER_RUN = 25;
const ALBUMS_PER_ARTIST = 10;

export default async function handler(request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const started = Date.now();
  let artistsProcessed = 0, albumsIngested = 0, failed = 0;

  try {
    const artists = await listKnownArtists(MAX_ARTISTS_PER_RUN);

    for (const artist of artists) {
      const deezerId = String(artist.id || "").replace("deezer-", "");
      if (!deezerId) continue;
      try {
        // les sorties les plus récentes d'abord : c'est tout l'intérêt du job
        const res = await fetch(
          `https://api.deezer.com/artist/${deezerId}/albums?limit=${ALBUMS_PER_ARTIST}`);
        const data = await res.json();
        const albums = (data.data || [])
          .sort((a, b) => String(b.release_date || "").localeCompare(String(a.release_date || "")))
          .slice(0, ALBUMS_PER_ARTIST);
        if (albums.length) {
          const rows = await ingestAlbums(albums);
          albumsIngested += rows.length;
        }
        await markArtistSynced(artist.id);
        artistsProcessed++;
      } catch (e) {
        failed++; // un artiste en échec ne doit pas arrêter la tournée
      }
    }
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({
    ok: true, artistsProcessed, albumsIngested, failed, ms: Date.now() - started,
  }), { headers: { "Content-Type": "application/json" } });
}
