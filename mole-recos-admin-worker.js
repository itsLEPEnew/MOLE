/**
 * Worker privé "Recos de la taupe" — page d'ajout + file d'attente + publication
 * automatique du vendredi. À protéger avec Cloudflare Access (voir plus bas) :
 * SANS Access, n'importe qui pourrait ajouter/supprimer des sons dans ta file.
 *
 * Déploiement (~10 minutes, un peu plus long que les Workers précédents) :
 *
 * 1. Si ce n'est pas déjà fait pour mole-recos-public-worker.js : crée le
 *    stockage partagé une seule fois — Workers & Pages > KV > Create a
 *    namespace (ex: "mole_recos").
 *
 * 2. Crée ce Worker : Workers & Pages > Create application > Start with
 *    Hello World!, colle ce code (remplace SPOTIFY_CLIENT_ID et
 *    SPOTIFY_CLIENT_SECRET si tu les as déjà — sinon laisse tel quel, tout le
 *    reste marche sans, Spotify restera juste vide dans les résultats).
 *
 * 3. Liaison KV — Settings > Bindings > Add > KV Namespace.
 *    Variable name : RECOS_KV (exactement ce nom).
 *    KV namespace : le même "mole_recos" que pour le Worker public.
 *
 * 4. Déclencheur du vendredi — Settings > Triggers > Cron Triggers > Add.
 *    Cloudflare programme en UTC, pas en heure de Paris : pour viser environ
 *    7h à Paris, mets "0 5 * * FRI" (5h UTC = 7h en été / 6h en hiver — un
 *    décalage d'une heure deux fois par an, sans conséquence pour ce cas).
 *
 * 5. Protection Cloudflare Access (essentiel, à faire avant de t'en servir) :
 *    Dans le dashboard, va dans "Zero Trust" (menu de gauche) > Access >
 *    Applications > Add an application > Self-hosted.
 *    - Domain : colle l'URL de CE Worker (xxx.ton-compte.workers.dev), sans
 *      chemin après.
 *    - Policy : "Allow", Include > Emails > ton adresse email uniquement.
 *    Une fois activé, seul toi (via un code reçu par email) pourras charger
 *    cette page ou toucher à la file — tout le reste du monde sera bloqué
 *    avant même d'atteindre le Worker.
 *
 * 6. Note l'URL de ce Worker — c'est ta page privée d'ajout, à ouvrir
 *    directement (et à viser depuis le Raccourci iOS de partage).
 */

const SPOTIFY_CLIENT_ID = "REMPLACE_PAR_TON_CLIENT_ID";
const SPOTIFY_CLIENT_SECRET = "REMPLACE_PAR_TON_CLIENT_SECRET";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(ADMIN_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/queue" && request.method === "GET") {
        return jsonResponse({ queue: await loadQueue(env) });
      }

      if (url.pathname === "/queue" && request.method === "POST") {
        const item = await request.json();
        const queue = await loadQueue(env);
        const newItem = {
          id: crypto.randomUUID(),
          addedAt: Date.now(),
          artist: item.artist || "",
          title: item.title || "",
          album: item.album || "",
          type: item.type === "album" ? "album" : "single",
          date: item.date || "",
          style: item.style || "",
          note: item.note || "",
          cover: item.cover || "",
          links: {
            spotify: (item.links && item.links.spotify) || null,
            deezer: (item.links && item.links.deezer) || null,
            appleMusic: (item.links && item.links.appleMusic) || null,
          },
        };
        queue.unshift(newItem);
        await saveQueue(env, queue);
        return jsonResponse({ item: newItem }, 201);
      }

      const queueItemMatch = url.pathname.match(/^\/queue\/([^/]+)$/);
      if (queueItemMatch && request.method === "PUT") {
        const id = queueItemMatch[1];
        const patch = await request.json();
        const queue = await loadQueue(env);
        const idx = queue.findIndex((it) => it.id === id);
        if (idx === -1) return jsonResponse({ error: "Not found" }, 404);
        queue[idx] = { ...queue[idx], ...patch, id: queue[idx].id };
        await saveQueue(env, queue);
        return jsonResponse({ item: queue[idx] });
      }

      if (queueItemMatch && request.method === "DELETE") {
        const id = queueItemMatch[1];
        const queue = await loadQueue(env);
        const filtered = queue.filter((it) => it.id !== id);
        await saveQueue(env, filtered);
        return jsonResponse({ ok: true });
      }

      if (url.pathname === "/queue-reorder" && request.method === "POST") {
        const body = await request.json();
        const order = Array.isArray(body.order) ? body.order : [];
        const queue = await loadQueue(env);
        const byId = new Map(queue.map((it) => [it.id, it]));
        const reordered = order.map((id) => byId.get(id)).filter(Boolean);
        // au cas où un id manquerait de la liste envoyée, on garde les autres à la fin
        queue.forEach((it) => {
          if (!order.includes(it.id)) reordered.push(it);
        });
        await saveQueue(env, reordered);
        return jsonResponse({ queue: reordered });
      }

      if (url.pathname === "/publish" && request.method === "POST") {
        const result = await publishQueue(env);
        return jsonResponse(result);
      }

      if (url.pathname === "/spotify-search" && request.method === "GET") {
        const q = url.searchParams.get("q") || "";
        const results = await spotifySearch(q);
        return jsonResponse({ results });
      }

      if (url.pathname === "/fetch-meta" && request.method === "GET") {
        const target = url.searchParams.get("url") || "";
        const meta = await fetchMeta(target);
        return jsonResponse(meta);
      }

      if (url.pathname === "/quick-add" && request.method === "POST") {
        const body = await request.json();
        const debug = url.searchParams.get("debug") ? [] : null;
        const item = await quickAddFromUrl(body.url || "", env, debug);
        if (!item) return jsonResponse({ error: "Rien trouvé pour ce lien", debug }, 422);
        return jsonResponse({ item, debug }, 201);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (e) {
      return jsonResponse({ error: "Erreur serveur", detail: String(e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(publishQueue(env));
  },
};

// ---------- stockage ----------
async function loadQueue(env) {
  const raw = await env.RECOS_KV.get("queue");
  return raw ? JSON.parse(raw) : [];
}
async function saveQueue(env, queue) {
  await env.RECOS_KV.put("queue", JSON.stringify(queue));
}
async function publishQueue(env) {
  const queue = await loadQueue(env);
  const wallRaw = await env.RECOS_KV.get("wall");
  const wall = wallRaw ? JSON.parse(wallRaw) : [];
  if (queue.length) {
    const weekKey = new Date().toISOString().slice(0, 10);
    const published = queue.map((it) => ({ ...it, publishedWeek: weekKey }));
    const newWall = published.concat(wall);
    await env.RECOS_KV.put("wall", JSON.stringify(newWall));
    await env.RECOS_KV.put("queue", JSON.stringify([]));
    return { wall: newWall, publishedCount: queue.length };
  }
  return { wall, publishedCount: 0 };
}

// ---------- Spotify (OAuth client credentials, caché côté serveur) ----------
async function spotifySearch(q) {
  if (!q || SPOTIFY_CLIENT_ID.startsWith("REMPLACE")) return [];
  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`),
      },
      body: "grant_type=client_credentials",
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return [];
    const searchRes = await fetch(
      `https://api.spotify.com/v1/search?type=track&limit=5&q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    const searchData = await searchRes.json();
    return ((searchData.tracks && searchData.tracks.items) || []).map((t) => ({
      artist: (t.artists || []).map((a) => a.name).join(", "),
      title: t.name,
      album: t.album && t.album.name,
      cover: t.album && t.album.images && t.album.images[0] && t.album.images[0].url,
      url: t.external_urls && t.external_urls.spotify,
    }));
  } catch (e) {
    return [];
  }
}

// ---------- métadonnées d'un lien partagé (Discogs, Bandcamp, etc.) ----------
async function fetchMeta(targetUrl) {
  if (!targetUrl) return { title: null, image: null, siteName: null };
  try {
    const res = await fetch(targetUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MoleBot/1.0)" },
    });
    const html = await res.text();
    const grab = (prop) => {
      const re1 = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i");
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, "i");
      const m = html.match(re1) || html.match(re2);
      return m ? decodeEntities(m[1]) : null;
    };
    return {
      title: grab("og:title"),
      image: grab("og:image"),
      siteName: grab("og:site_name"),
    };
  } catch (e) {
    return { title: null, image: null, siteName: null };
  }
}
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// ---------- ajout auto complet (pour le Raccourci de partage iOS) ----------
// résout tout côté serveur (métadonnées + Spotify/Deezer/Apple Music) et ajoute
// directement à la file — pas d'appel JSONP nécessaire ici, un Worker n'est pas
// soumis aux restrictions CORS du navigateur, donc un fetch direct vers Deezer marche.
async function quickAddFromUrl(rawUrl, env, debug) {
  if (!rawUrl) return null;
  let artist = "", title = "", album = "", date = "", cover = "", type = "single";
  let appleUrl = null, deezerUrl = null, spotifyUrl = null;

  if (rawUrl.includes("music.apple.com")) {
    let appleId = null;
    let hasTrackParam = false;
    try {
      const u = new URL(rawUrl);
      const iParam = u.searchParams.get("i");
      if (iParam && /^[0-9]+$/.test(iParam)) {
        appleId = iParam;
        hasTrackParam = true;
      } else {
        const segments = u.pathname.split("/").filter(Boolean);
        const last = segments[segments.length - 1];
        if (last && /^[0-9]+$/.test(last)) appleId = last;
      }
    } catch (e) { if (debug) debug.push("url parse error: " + e.message); }
    if (debug) debug.push("appleId=" + appleId);
    let itunesOk = false;
    if (appleId) {
      try {
        const res = await fetch("https://itunes.apple.com/lookup?id=" + appleId, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" },
        });
        if (debug) debug.push("itunes lookup status=" + res.status);
        if (res.ok) {
          const data = await res.json();
          if (debug) debug.push("itunes lookup resultCount=" + data.resultCount);
          const t = data.results && data.results[0];
          if (t) {
            itunesOk = true;
            type = !t.trackName && t.wrapperType === "collection" ? "album" : "single";
            artist = t.artistName || "";
            title = t.trackName || "";
            album = t.collectionName || "";
            date = (t.releaseDate || "").slice(0, 10);
            cover = (t.artworkUrl100 || "").replace("100x100bb", "600x600bb");
            appleUrl = t.trackViewUrl || t.collectionViewUrl || null;
          }
        }
      } catch (e) { if (debug) debug.push("itunes lookup error: " + e.message); }
    }
    // repli : l'API iTunes peut renvoyer 403 depuis l'IP partagée de Cloudflare.
    // on lit alors directement la page Apple Music partagée (og:title/og:image),
    // un chemin différent de celui de l'API bloquée.
    if (!itunesOk) {
      if (debug) debug.push("fallback: scraping og tags from apple music page");
      appleUrl = rawUrl;
      type = hasTrackParam ? "single" : "album";
      const meta = await fetchMeta(rawUrl);
      if (debug) debug.push("apple page meta title=" + meta.title);
      if (meta.title) {
        const byIdx = meta.title.lastIndexOf(" by ");
        if (byIdx !== -1) {
          artist = meta.title.slice(byIdx + 4).trim();
          let left = meta.title.slice(0, byIdx).trim();
          [" - Song", " - Album", " - Single", " - EP"].forEach((suffix) => {
            if (left.endsWith(suffix)) left = left.slice(0, -suffix.length).trim();
          });
          if (type === "album") album = left; else title = left;
        } else {
          if (type === "album") album = meta.title; else title = meta.title;
        }
      }
      if (meta.image) cover = meta.image;
    }
  } else {
    const meta = await fetchMeta(rawUrl);
    if (meta.title) {
      const parts = meta.title.split(/ [-–] /);
      if (parts.length >= 2) {
        artist = parts[0].trim();
        title = parts.slice(1).join(" - ").trim();
      } else {
        title = meta.title;
      }
    }
    if (meta.image) cover = meta.image;
  }

  const q = (artist + " " + (title || album)).trim();
  if (q) {
    if (!deezerUrl) {
      try {
        const dRes = await fetch("https://api.deezer.com/search?q=" + encodeURIComponent(q));
        const dData = await dRes.json();
        const best = (dData.data || [])[0];
        if (best) deezerUrl = best.link;
        if (!cover && best && best.album) cover = best.album.cover_medium;
      } catch (e) { /* pas grave */ }
    }
    if (!spotifyUrl) {
      const spotifyResults = await spotifySearch(q);
      if (spotifyResults[0]) spotifyUrl = spotifyResults[0].url;
    }
    if (!appleUrl) {
      try {
        const aRes = await fetch("https://itunes.apple.com/search?term=" + encodeURIComponent(q) + "&media=music&entity=song&limit=1", {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" },
        });
        const aData = await aRes.json();
        const best = (aData.results || [])[0];
        if (best) {
          appleUrl = best.trackViewUrl || null;
          if (!artist) artist = best.artistName || "";
          if (!title) title = best.trackName || "";
          if (!album) album = best.collectionName || "";
          if (!cover) cover = (best.artworkUrl100 || "").replace("100x100bb", "600x600bb");
        }
      } catch (e) { /* pas grave */ }
    }
  }

  if (!artist && !title && !album) return null;

  const newItem = {
    id: crypto.randomUUID(),
    addedAt: Date.now(),
    artist: artist || "?",
    title,
    album,
    type,
    date,
    style: "",
    note: "",
    cover,
    links: { spotify: spotifyUrl, deezer: deezerUrl, appleMusic: appleUrl },
  };
  const queue = await loadQueue(env);
  queue.unshift(newItem);
  await saveQueue(env, queue);
  return newItem;
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
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ---------- page privée (HTML servi directement par ce Worker) ----------
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recos de la taupe — coulisses</title>
<style>
  :root{ --paper:#141210; --ink:#f2eee4; --ink-soft:#a89f8f; --card:#1e1b15; --line:#3a352c; --accent:#f2eee4; }
  *{box-sizing:border-box;}
  body{ margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--paper); color:var(--ink); padding:16px 16px 60px; }
  h1{ font-size:18px; margin:0 0 4px; }
  .sub{ color:var(--ink-soft); font-size:12.5px; margin:0 0 20px; }
  .card{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:16px; }
  label{ display:block; font-size:11.5px; color:var(--ink-soft); margin:10px 0 4px; text-transform:uppercase; letter-spacing:0.4px; }
  input, textarea{ width:100%; background:var(--paper); border:1px solid var(--line); border-radius:6px; padding:9px 10px; color:var(--ink); font-size:14px; font-family:inherit; }
  textarea{ min-height:60px; resize:vertical; }
  button{ background:var(--ink); color:var(--paper); border:none; border-radius:6px; padding:10px 14px; font-size:13.5px; font-weight:700; cursor:pointer; }
  button.ghost{ background:transparent; color:var(--ink); border:1px solid var(--line); }
  button.small{ padding:5px 9px; font-size:12px; }
  button:disabled{ opacity:0.5; }
  .type-btn{ background:transparent; color:var(--ink-soft); border:1px solid var(--line); }
  .type-btn.active{ background:var(--ink); color:var(--paper); border-color:var(--ink); }
  .row{ display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .match-list{ display:flex; flex-direction:column; gap:6px; margin-top:8px; }
  .match{ display:flex; align-items:center; gap:8px; border:1px solid var(--line); border-radius:6px; padding:6px 8px; font-size:12.5px; }
  .match img{ width:32px; height:32px; object-fit:cover; border-radius:3px; flex-shrink:0; }
  .match .info{ flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .match.selected{ border-color:var(--ink); background:rgba(255,255,255,0.05); }
  .cover-preview{ width:100%; max-width:180px; aspect-ratio:1/1; object-fit:cover; border-radius:6px; margin-top:8px; background:var(--paper); border:1px solid var(--line); }
  .queue-row{ display:flex; gap:10px; align-items:center; border-bottom:1px solid var(--line); padding:10px 0; }
  .queue-row:last-child{ border-bottom:none; }
  .queue-row img{ width:44px; height:44px; object-fit:cover; border-radius:5px; flex-shrink:0; background:var(--paper); }
  .queue-row .info{ flex:1; min-width:0; }
  .queue-row .info .t{ font-weight:700; font-size:13px; }
  .queue-row .info .s{ color:var(--ink-soft); font-size:11.5px; }
  .status{ font-size:12.5px; color:var(--ink-soft); margin-top:8px; min-height:16px; }
  .empty{ color:var(--ink-soft); font-size:13px; }
</style>
</head>
<body>

<h1>Recos de la taupe — coulisses</h1>
<p class="sub">File d'attente privée. Tout ce qui est ici part au prochain vendredi.</p>

<div class="card">
  <label>Lien partagé (optionnel — pré-remplit le reste)</label>
  <input id="sharedUrl" type="url" placeholder="https://...">
  <div class="row"><button id="lookupBtn" class="ghost">Analyser le lien</button></div>

  <label>Type</label>
  <div class="row" style="margin-top:0;">
    <button type="button" id="typeSingleBtn" class="type-btn active">Single</button>
    <button type="button" id="typeAlbumBtn" class="type-btn">Album</button>
  </div>

  <label>Artiste</label>
  <input id="fArtist" type="text">
  <label id="titleLabel">Titre</label>
  <input id="fTitle" type="text">
  <label>Album</label>
  <input id="fAlbum" type="text">
  <label>Date de sortie</label>
  <input id="fDate" type="text" placeholder="2024 ou 2024-05-01">
  <label>Style</label>
  <input id="fStyle" type="text" placeholder="Deep house, Boom bap...">
  <label>Note perso de la taupe</label>
  <textarea id="fNote" placeholder="Pourquoi ce son, où tu l'as trouvé..."></textarea>

  <img id="coverPreview" class="cover-preview" style="display:none;">

  <div class="row"><button id="searchLinksBtn" class="ghost">Chercher les liens (Spotify / Deezer / Apple Music)</button></div>
  <div id="matchesSpotify" class="match-list"></div>
  <div id="matchesDeezer" class="match-list"></div>
  <div id="matchesApple" class="match-list"></div>

  <div class="row"><button id="addBtn">Ajouter à la file</button></div>
  <div id="addStatus" class="status"></div>
</div>

<div class="card">
  <div class="row" style="margin-top:0;justify-content:space-between;align-items:center;">
    <strong style="font-size:14px;">File d'attente</strong>
    <button id="publishBtn" class="ghost small">Publier maintenant</button>
  </div>
  <div id="queueList" style="margin-top:10px;"></div>
</div>

<script>
let selected = { spotify: null, deezer: null, apple: null };
let resolvedCover = "";
let entryType = "single";

const $ = (id) => document.getElementById(id);

function setEntryType(type){
  entryType = type;
  $("typeSingleBtn").classList.toggle("active", type === "single");
  $("typeAlbumBtn").classList.toggle("active", type === "album");
  $("titleLabel").textContent = type === "album" ? "Titre (optionnel pour un album)" : "Titre";
}
$("typeSingleBtn").addEventListener("click", () => setEntryType("single"));
$("typeAlbumBtn").addEventListener("click", () => setEntryType("album"));

$("lookupBtn").addEventListener("click", lookupSharedUrl);
$("searchLinksBtn").addEventListener("click", searchLinks);
$("addBtn").addEventListener("click", addToQueue);
$("publishBtn").addEventListener("click", publishNow);

async function lookupSharedUrl(){
  const raw = $("sharedUrl").value.trim();
  if(!raw) return;
  $("addStatus").textContent = "Analyse du lien...";
  try{
    if(raw.includes("music.apple.com")){
      // extraction sans regex à antislashs (fragile au copier-coller) : on lit
      // le paramètre ?i= de l'URL, sinon le dernier segment numérique du chemin
      let appleId = null;
      try{
        const u = new URL(raw);
        const iParam = u.searchParams.get("i");
        if(iParam && /^[0-9]+$/.test(iParam)){
          appleId = iParam;
        } else {
          const segments = u.pathname.split("/").filter(Boolean);
          const last = segments[segments.length - 1];
          if(last && /^[0-9]+$/.test(last)) appleId = last;
        }
      }catch(e){ /* URL invalide, on laissera l'utilisateur remplir à la main */ }
      if(appleId){
        const res = await fetch("https://itunes.apple.com/lookup?id=" + appleId);
        const data = await res.json();
        const t = data.results && data.results[0];
        if(t){
          const isAlbum = !t.trackName && t.wrapperType === "collection";
          setEntryType(isAlbum ? "album" : "single");
          $("fArtist").value = t.artistName || "";
          $("fTitle").value = t.trackName || "";
          $("fAlbum").value = t.collectionName || "";
          $("fDate").value = (t.releaseDate || "").slice(0,10);
          resolvedCover = (t.artworkUrl100 || "").replace("100x100bb", "600x600bb");
          showCover(resolvedCover);
          selected.apple = { url: t.trackViewUrl || t.collectionViewUrl };
          renderMatches();
        }
      }
    } else {
      const res = await fetch("/fetch-meta?url=" + encodeURIComponent(raw));
      const meta = await res.json();
      if(meta.title){
        const parts = meta.title.split(/ [-–] /);
        if(parts.length >= 2){
          $("fArtist").value = parts[0].trim();
          $("fTitle").value = parts.slice(1).join(" - ").trim();
        } else {
          $("fTitle").value = meta.title;
        }
      }
      if(meta.image){ resolvedCover = meta.image; showCover(resolvedCover); }
    }
    $("addStatus").textContent = "Vérifie/complète les champs, puis cherche les liens.";
  }catch(e){
    $("addStatus").textContent = "Impossible d'analyser ce lien — remplis les champs à la main.";
  }
}

function showCover(url){
  const img = $("coverPreview");
  if(url){ img.src = url; img.style.display = "block"; }
}

async function searchLinks(){
  const artist = $("fArtist").value.trim();
  const title = $("fTitle").value.trim();
  if(!artist || !title){
    $("addStatus").textContent = "Renseigne au moins artiste + titre avant de chercher.";
    return;
  }
  $("addStatus").textContent = "Recherche en cours...";
  const q = artist + " " + title;

  // Apple Music (si pas déjà résolu via le lien partagé)
  if(!selected.apple){
    try{
      const res = await fetch("https://itunes.apple.com/search?term=" + encodeURIComponent(q) + "&media=music&entity=song&limit=5");
      const data = await res.json();
      window.__appleResults = (data.results || []).map(t => ({
        artist: t.artistName, title: t.trackName, album: t.collectionName,
        cover: (t.artworkUrl100||"").replace("100x100bb","300x300bb"), url: t.trackViewUrl
      }));
    }catch(e){ window.__appleResults = []; }
  } else {
    window.__appleResults = [];
  }

  // Deezer (JSONP, requis par leur API pour un appel depuis le navigateur)
  window.__deezerResults = await new Promise((resolve) => {
    const cbName = "molecb" + Date.now();
    window[cbName] = (data) => {
      resolve((data.data || []).map(t => ({
        artist: t.artist && t.artist.name, title: t.title, album: t.album && t.album.title,
        cover: t.album && t.album.cover_medium, url: t.link
      })));
      delete window[cbName];
      script.remove();
    };
    const script = document.createElement("script");
    script.src = "https://api.deezer.com/search?q=" + encodeURIComponent(q) + "&output=jsonp&callback=" + cbName;
    script.onerror = () => resolve([]);
    document.body.appendChild(script);
    setTimeout(() => resolve([]), 4000);
  });

  // Spotify (via ce Worker, clé cachée côté serveur)
  try{
    const res = await fetch("/spotify-search?q=" + encodeURIComponent(q));
    const data = await res.json();
    window.__spotifyResults = data.results || [];
  }catch(e){ window.__spotifyResults = []; }

  renderMatches();
  $("addStatus").textContent = "Choisis la bonne version pour chaque plateforme (ou laisse vide).";
}

function renderMatches(){
  renderMatchList("matchesSpotify", "Spotify", window.__spotifyResults || [], "spotify");
  renderMatchList("matchesDeezer", "Deezer", window.__deezerResults || [], "deezer");
  renderMatchList("matchesApple", "Apple Music", window.__appleResults || [], "apple");
}

function renderMatchList(elId, label, results, key){
  const el = $(elId);
  if(!results.length && !selected[key]){ el.innerHTML = ""; return; }
  el.innerHTML = "<div style='font-size:11px;color:var(--ink-soft);margin-top:6px;'>" + label + "</div>";
  if(selected[key] && !results.length){
    const row = document.createElement("div");
    row.className = "match selected";
    row.innerHTML = "<div class='info'>Lien retenu ✓</div>";
    el.appendChild(row);
    return;
  }
  results.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "match" + (selected[key] && selected[key].url === r.url ? " selected" : "");
    row.innerHTML = (r.cover ? "<img src='"+r.cover+"'>" : "") +
      "<div class='info'>" + (r.artist||"") + " – " + (r.title||"") + (r.album ? " (" + r.album + ")" : "") + "</div>";
    row.addEventListener("click", () => {
      selected[key] = r;
      if(!resolvedCover && r.cover){ resolvedCover = r.cover; showCover(resolvedCover); }
      renderMatches();
    });
    el.appendChild(row);
  });
}

async function addToQueue(){
  const artist = $("fArtist").value.trim();
  const title = $("fTitle").value.trim();
  const album = $("fAlbum").value.trim();
  if(!artist || (!title && !album)){
    $("addStatus").textContent = "Artiste obligatoire, plus au moins Titre ou Album.";
    return;
  }
  const item = {
    artist, title, album,
    type: entryType,
    date: $("fDate").value.trim(),
    style: $("fStyle").value.trim(),
    note: $("fNote").value.trim(),
    cover: resolvedCover,
    links: {
      spotify: selected.spotify ? selected.spotify.url : null,
      deezer: selected.deezer ? selected.deezer.url : null,
      appleMusic: selected.apple ? selected.apple.url : null
    }
  };
  $("addStatus").textContent = "Ajout...";
  try{
    const res = await fetch("/queue", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(item) });
    if(!res.ok) throw new Error("failed");
    $("addStatus").textContent = "Ajouté à la file ✓";
    ["sharedUrl","fArtist","fTitle","fAlbum","fDate","fStyle","fNote"].forEach(id => $(id).value = "");
    resolvedCover = "";
    $("coverPreview").style.display = "none";
    selected = { spotify:null, deezer:null, apple:null };
    setEntryType("single");
    renderMatches();
    loadQueue();
  }catch(e){
    $("addStatus").textContent = "Erreur lors de l'ajout — réessaie.";
  }
}

async function loadQueue(){
  const list = $("queueList");
  let data;
  try{
    const res = await fetch("/queue");
    data = await res.json();
  }catch(e){
    list.innerHTML = "<div class='empty'>Impossible de charger la file pour le moment.</div>";
    return;
  }
  if(!data.queue || !data.queue.length){
    list.innerHTML = "<div class='empty'>File vide pour l'instant.</div>";
    return;
  }
  list.innerHTML = "";
  data.queue.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "queue-row";
    const mainTitle = it.title || it.album || "(sans titre)";
    row.innerHTML =
      (it.cover ? "<img src='"+it.cover+"'>" : "<div style='width:44px;height:44px;'></div>") +
      "<div class='info'><div class='t'>" + esc(it.artist) + " – " + esc(mainTitle) + "</div><div class='s'>" + (it.type === "album" ? "Album" : "Single") + (it.style?" · "+esc(it.style):"") + "</div></div>";
    const btnUp = document.createElement("button");
    btnUp.className = "small ghost"; btnUp.textContent = "↑";
    btnUp.disabled = idx === 0;
    btnUp.onclick = () => reorder(data.queue, idx, idx-1);
    const btnDown = document.createElement("button");
    btnDown.className = "small ghost"; btnDown.textContent = "↓";
    btnDown.disabled = idx === data.queue.length-1;
    btnDown.onclick = () => reorder(data.queue, idx, idx+1);
    const btnDel = document.createElement("button");
    btnDel.className = "small ghost"; btnDel.textContent = "✕";
    btnDel.onclick = () => removeItem(it.id);
    row.appendChild(btnUp); row.appendChild(btnDown); row.appendChild(btnDel);
    list.appendChild(row);
  });
}

async function reorder(queue, from, to){
  const ids = queue.map(it => it.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  await fetch("/queue-reorder", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({order: ids}) });
  loadQueue();
}

async function removeItem(id){
  await fetch("/queue/" + id, { method:"DELETE" });
  loadQueue();
}

async function publishNow(){
  if(!confirm("Publier toute la file maintenant sur le mur public ?")) return;
  try{
    const res = await fetch("/publish", { method:"POST" });
    const data = await res.json();
    $("addStatus").textContent = data.publishedCount > 0
      ? "Publié ✓ (" + data.publishedCount + " son" + (data.publishedCount > 1 ? "s" : "") + ")"
      : "Rien à publier — la file était vide.";
  }catch(e){
    $("addStatus").textContent = "Erreur lors de la publication — réessaie.";
  }
  loadQueue();
}

function esc(s){
  return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// pré-remplissage direct si arrivée via le Raccourci de partage (?shared=...)
const params = new URLSearchParams(location.search);
if(params.get("shared")){
  $("sharedUrl").value = params.get("shared");
  lookupSharedUrl();
}
loadQueue();
</script>
</body>
</html>`;
