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
      // page d'admin protégée par un simple mot de passe maison (cookie),
      // plus de Cloudflare Access ici — voir isAdminAuthed()/login/ ci-dessous.
      if (url.pathname === "/" && request.method === "GET") {
        if (!isAdminAuthed(request, env)) {
          return new Response(LOGIN_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response(ADMIN_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/login" && request.method === "POST") {
        const body = await request.json();
        if (!env.QUICK_ADD_SECRET || body.password !== env.QUICK_ADD_SECRET) {
          return jsonResponse({ error: "Mot de passe incorrect" }, 401);
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "admin_key=" + env.QUICK_ADD_SECRET + "; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax",
            ...corsHeaders(),
          },
        });
      }

      // porte à part réservée au Raccourci iOS : une simple clé secrète dans
      // l'URL (QUICK_ADD_SECRET), pas de cookie nécessaire ici.
      if (url.pathname === "/quick" && request.method === "GET") {
        const key = url.searchParams.get("key") || "";
        if (!env.QUICK_ADD_SECRET || key !== env.QUICK_ADD_SECRET) {
          return new Response("Accès refusé", { status: 403 });
        }
        return new Response(QUICK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/quick/save" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!env.QUICK_ADD_SECRET || key !== env.QUICK_ADD_SECRET) {
          return jsonResponse({ error: "Accès refusé" }, 403);
        }
        const newItem = buildQueueItem(body);
        const queue = await loadQueue(env);
        queue.unshift(newItem);
        await saveQueue(env, queue);
        return jsonResponse({ item: newItem }, 201);
      }

      // tout ce qui suit (file, mur, publication, recherche...) exige le
      // cookie posé par /login — /quick et /quick/save restent à part.
      if (!isAdminAuthed(request, env)) {
        return jsonResponse({ error: "Non connecté" }, 401);
      }

      if (url.pathname === "/queue" && request.method === "GET") {
        return jsonResponse({ queue: await loadQueue(env) });
      }

      if (url.pathname === "/queue" && request.method === "POST") {
        const item = await request.json();
        const queue = await loadQueue(env);
        const newItem = buildQueueItem(item);
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

      if (url.pathname === "/wall" && request.method === "GET") {
        return jsonResponse({ wall: await loadWall(env) });
      }

      const wallItemMatch = url.pathname.match(/^\/wall\/([^/]+)$/);
      if (wallItemMatch && request.method === "PUT") {
        const id = wallItemMatch[1];
        const patch = await request.json();
        const wall = await loadWall(env);
        const idx = wall.findIndex((it) => it.id === id);
        if (idx === -1) return jsonResponse({ error: "Not found" }, 404);
        wall[idx] = { ...wall[idx], ...patch, id: wall[idx].id };
        await saveWall(env, wall);
        return jsonResponse({ item: wall[idx] });
      }

      if (wallItemMatch && request.method === "DELETE") {
        const id = wallItemMatch[1];
        const wall = await loadWall(env);
        const filtered = wall.filter((it) => it.id !== id);
        await saveWall(env, filtered);
        return jsonResponse({ ok: true });
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
        if (debug) debug.push("received appleData=" + (body.appleData ? JSON.stringify(body.appleData).slice(0, 300) : "none"));
        const item = await quickAddFromUrl(body.url || "", env, debug, body.appleData || null);
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
function buildQueueItem(item) {
  return {
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
    indispensable: !!item.indispensable,
    links: {
      spotify: (item.links && item.links.spotify) || null,
      deezer: (item.links && item.links.deezer) || null,
      appleMusic: (item.links && item.links.appleMusic) || null,
    },
  };
}
async function loadQueue(env) {
  const raw = await env.RECOS_KV.get("queue");
  return raw ? JSON.parse(raw) : [];
}
async function saveQueue(env, queue) {
  await env.RECOS_KV.put("queue", JSON.stringify(queue));
}
async function loadWall(env) {
  const raw = await env.RECOS_KV.get("wall");
  return raw ? JSON.parse(raw) : [];
}
async function saveWall(env, wall) {
  await env.RECOS_KV.put("wall", JSON.stringify(wall));
}
async function publishQueue(env) {
  const queue = await loadQueue(env);
  const wall = await loadWall(env);
  if (queue.length) {
    const weekKey = new Date().toISOString().slice(0, 10);
    const published = queue.map((it) => ({ ...it, publishedWeek: weekKey }));
    const newWall = published.concat(wall);
    await saveWall(env, newWall);
    await saveQueue(env, []);
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
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        "Accept-Language": "en-US,en;q=0.9",
      },
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
async function quickAddFromUrl(rawUrl, env, debug, clientApple) {
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
    // le raccourci iOS peut avoir déjà résolu le lien lui-même (depuis le
    // téléphone, jamais bloqué par Apple contrairement à l'IP du Worker) et
    // nous passer directement le résultat de itunes.apple.com/lookup.
    if (clientApple && clientApple.artistName) {
      if (debug) debug.push("using client-resolved apple data");
      itunesOk = true;
      type = !clientApple.trackName && clientApple.wrapperType === "collection" ? "album" : "single";
      artist = clientApple.artistName || "";
      title = clientApple.trackName || "";
      album = clientApple.collectionName || "";
      date = (clientApple.releaseDate || "").slice(0, 10);
      cover = (clientApple.artworkUrl100 || "").replace("100x100bb", "600x600bb");
      appleUrl = clientApple.trackViewUrl || clientApple.collectionViewUrl || rawUrl;
    }
    if (!itunesOk && appleId) {
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
        let t = meta.title.replace(/\s+/g, " ").trim();
        [" sur Apple Music", " on Apple Music", " – Apple Music", " - Apple Music"].forEach((suffix) => {
          if (t.endsWith(suffix)) t = t.slice(0, -suffix.length).trim();
        });
        let sepIdx = t.lastIndexOf(" par ");
        let sepLen = 5;
        if (sepIdx === -1) { sepIdx = t.lastIndexOf(" by "); sepLen = 4; }
        if (sepIdx !== -1) {
          artist = t.slice(sepIdx + sepLen).trim();
          let left = t.slice(0, sepIdx).trim();
          [" - Song", " - Album", " - Single", " - EP", " - Chanson"].forEach((suffix) => {
            if (left.endsWith(suffix)) left = left.slice(0, -suffix.length).trim();
          });
          if (type === "album") album = left; else title = left;
        } else {
          if (type === "album") album = t; else title = t;
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

const FAVICON_B64 = "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";

// ---------- connexion (mot de passe maison, remplace Cloudflare Access) ----------
function isAdminAuthed(request, env) {
  if (!env.QUICK_ADD_SECRET) return false;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("admin_key="));
  if (!match) return false;
  return match.slice("admin_key=".length) === env.QUICK_ADD_SECRET;
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recos de la taupe — connexion</title>
<link rel="icon" type="image/png" href="data:image/png;base64,${FAVICON_B64}">
<style>
  :root{ --paper:#16140f; --ink:#f2eee4; --ink-soft:#b8b0a0; --card:#1e1b15; }
  *{box-sizing:border-box;}
  body{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif; background:var(--paper); color:var(--ink); }
  .card{ background:var(--card); border:1px solid #3a352c; border-radius:10px; padding:22px; width:100%; max-width:280px; }
  h1{ font-size:15px; margin:0 0 14px; text-align:center; }
  input{ width:100%; background:var(--paper); border:1px solid #3a352c; border-radius:6px; padding:10px; color:var(--ink); font-size:14px; }
  button{ width:100%; background:var(--ink); color:var(--paper); border:none; border-radius:6px; padding:11px; font-size:14px; font-weight:700; cursor:pointer; margin-top:10px; }
  .status{ font-size:12.5px; color:var(--ink-soft); margin-top:10px; min-height:16px; text-align:center; }
</style>
</head>
<body>
<div class="card">
  <h1>Recos de la taupe — coulisses</h1>
  <input id="pw" type="password" placeholder="Mot de passe" autofocus>
  <button id="go">Se connecter</button>
  <div id="status" class="status"></div>
</div>
<script>
async function tryLogin(){
  const password = document.getElementById("pw").value;
  document.getElementById("status").textContent = "Connexion...";
  try{
    const res = await fetch("/login", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({password}) });
    if(res.ok){ location.reload(); }
    else { document.getElementById("status").textContent = "Mot de passe incorrect."; }
  }catch(e){
    document.getElementById("status").textContent = "Erreur — réessaie.";
  }
}
document.getElementById("go").addEventListener("click", tryLogin);
document.getElementById("pw").addEventListener("keydown", (e) => { if(e.key === "Enter") tryLogin(); });
</script>
</body>
</html>`;

// ---------- page privée (HTML servi directement par ce Worker) ----------
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recos de la taupe — coulisses</title>
<link rel="icon" type="image/png" href="data:image/png;base64,${FAVICON_B64}">
<style>
  :root{ --paper:#16140f; --paper-dim:#221f19; --ink:#f2eee4; --ink-soft:#b8b0a0; --card:#1e1b15; --line:#f2eee4; --accent:#f2eee4; }
  *{box-sizing:border-box;}
  body{ margin:0; font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif; background:var(--paper); color:var(--ink); padding:16px 16px 60px; }
  h1{ font-size:18px; margin:0 0 4px; letter-spacing:0.5px; }
  .sub{ color:var(--ink-soft); font-size:12.5px; margin:0 0 18px; }
  .card{ background:var(--card); border:1px solid var(--line-soft,#3a352c); border-radius:10px; padding:14px; margin-bottom:16px; }
  label{ display:block; font-size:11.5px; color:var(--ink-soft); margin:10px 0 4px; text-transform:uppercase; letter-spacing:0.4px; }
  input, textarea, select{ width:100%; background:var(--paper); border:1px solid #3a352c; border-radius:6px; padding:9px 10px; color:var(--ink); font-size:14px; font-family:inherit; }
  textarea{ min-height:60px; resize:vertical; }
  input[type="checkbox"]{ width:auto; }
  .checkbox-row{ display:flex; align-items:center; gap:8px; text-transform:none; letter-spacing:normal; font-size:13.5px; color:var(--ink); margin-top:14px; }
  button{ background:var(--ink); color:var(--paper); border:none; border-radius:6px; padding:10px 14px; font-size:13.5px; font-weight:700; cursor:pointer; }
  button.ghost{ background:transparent; color:var(--ink); border:1px solid #3a352c; }
  button.small{ padding:5px 9px; font-size:12px; }
  button:disabled{ opacity:0.5; }
  .type-btn{ background:transparent; color:var(--ink-soft); border:1px solid #3a352c; }
  .type-btn.active{ background:var(--ink); color:var(--paper); border-color:var(--ink); }
  .row{ display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .match-list{ display:flex; flex-direction:column; gap:6px; margin-top:8px; }
  .match{ display:flex; align-items:center; gap:8px; border:1px solid #3a352c; border-radius:6px; padding:6px 8px; font-size:12.5px; }
  .match img{ width:32px; height:32px; object-fit:cover; border-radius:3px; flex-shrink:0; }
  .match .info{ flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .match.selected{ border-color:var(--ink); background:rgba(255,255,255,0.05); }
  .cover-preview{ width:100%; max-width:180px; aspect-ratio:1/1; object-fit:cover; border-radius:6px; margin-top:8px; background:var(--paper); border:1px solid #3a352c; }
  .queue-row{ display:flex; gap:10px; align-items:center; border-bottom:1px solid #3a352c; padding:10px 0; }
  .queue-row:last-child{ border-bottom:none; }
  .queue-row img{ width:44px; height:44px; object-fit:cover; border-radius:5px; flex-shrink:0; background:var(--paper); }
  .queue-row .info{ flex:1; min-width:0; }
  .queue-row .info .t{ font-weight:700; font-size:13px; }
  .queue-row .info .s{ color:var(--ink-soft); font-size:11.5px; }
  .status{ font-size:12.5px; color:var(--ink-soft); margin-top:8px; min-height:16px; }
  .empty{ color:var(--ink-soft); font-size:13px; }

  /* logo animé, repris de MOLE */
  .mole-header{ display:flex; flex-direction:column; align-items:center; text-align:center; margin-bottom:18px; }
  .mole-logo-wrap{ position:relative; width:84px; height:84px; margin-bottom:6px; animation:molePopIn 1.1s cubic-bezier(.34,1.56,.64,1) 1 both; }
  .mole-logo-wrap .mole-note{ position:absolute; color:var(--ink-soft); animation:noteOrbit 5s ease-in-out infinite; }
  .mole-logo-wrap .mole-note.n1{ top:19%; right:20%; font-size:10px; animation-delay:0s; }
  .mole-logo-wrap .mole-note.n2{ top:15%; right:38%; font-size:7px; animation-delay:.6s; }
  .mole-logo-wrap .mole-note.n3{ top:29%; right:10%; font-size:5px; animation-delay:1.1s; }
  .mole-layer{ position:absolute; inset:0; background-color:var(--ink); -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat; -webkit-mask-position:center; mask-position:center; -webkit-mask-size:contain; mask-size:contain; }
  .mole-paws{ -webkit-mask-image:url('https://itslepenew.github.io/MOLE/mole-paws.png'); mask-image:url('https://itslepenew.github.io/MOLE/mole-paws.png'); }
  .mole-head{ -webkit-mask-image:url('https://itslepenew.github.io/MOLE/mole-head.png'); mask-image:url('https://itslepenew.github.io/MOLE/mole-head.png'); animation:headSway 2.4s ease-in-out infinite; transform-origin:50% 85%; }
  @keyframes headSway{ 0%,100%{ transform:translate(-1px,0) rotate(-0.8deg); } 50%{ transform:translate(1px,-0.6px) rotate(0.8deg); } }
  @keyframes molePopIn{ 0%{ transform:translateY(30px) scale(.7); opacity:0; } 55%{ transform:translateY(-7px) scale(1.06); opacity:1; } 75%{ transform:translateY(2px) scale(.98); } 100%{ transform:translateY(0) scale(1); opacity:1; } }
  @keyframes noteOrbit{ 0%,100%{ transform:translate(0,0) rotate(-4deg); } 50%{ transform:translate(-6px,-8px) rotate(6deg); } }

  /* onglets */
  .tabs{ display:flex; gap:6px; margin-bottom:16px; border-bottom:1px solid #3a352c; }
  .tab-btn{ background:transparent; color:var(--ink-soft); border:none; border-radius:0; padding:9px 4px; font-size:13px; font-weight:700; border-bottom:2px solid transparent; }
  .tab-btn.active{ color:var(--ink); border-bottom-color:var(--ink); }
  .tab-panel{ display:none; }
  .tab-panel.active{ display:block; }

  /* mur public */
  .wall-filters{ display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
  .wall-filters select, .wall-filters input{ width:auto; flex:1; min-width:120px; }
  .wall-week-head{ font-size:11.5px; color:var(--ink-soft); text-transform:uppercase; letter-spacing:0.4px; margin:18px 0 8px; }
  .wall-week-head:first-child{ margin-top:0; }
  .wall-grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; }
  .wall-card{ background:var(--card); border:1px solid #3a352c; border-radius:10px; padding:10px; }
  .wall-card img{ width:100%; aspect-ratio:1/1; object-fit:cover; border-radius:6px; background:var(--paper); }
  .wall-card .t{ font-weight:700; font-size:12.5px; margin-top:8px; }
  .wall-card .s{ color:var(--ink-soft); font-size:11px; margin-top:2px; }
  .wall-card .actions{ display:flex; gap:6px; margin-top:8px; }
</style>
</head>
<body>

<div class="mole-header">
  <div class="mole-logo-wrap">
    <div class="mole-layer mole-paws"></div>
    <div class="mole-layer mole-head"></div>
    <span class="mole-note n1">&#9834;</span>
    <span class="mole-note n2">&#9835;</span>
    <span class="mole-note n3">&#9834;</span>
  </div>
  <h1>Recos de la taupe — coulisses</h1>
  <p class="sub">Tout ce qui est ici part au prochain vendredi.</p>
</div>

<div class="tabs">
  <button class="tab-btn active" data-tab="add">Ajouter</button>
  <button class="tab-btn" data-tab="queue">File d'attente</button>
  <button class="tab-btn" data-tab="wall">Mur public</button>
</div>

<div id="tab-add" class="tab-panel active">
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
  <input id="fStyle" type="text" list="styleOptions" placeholder="Deep house, Boom bap...">
  <datalist id="styleOptions"></datalist>
  <label>Note perso de la taupe</label>
  <textarea id="fNote" placeholder="Pourquoi ce son, où tu l'as trouvé..."></textarea>

  <label class="checkbox-row"><input type="checkbox" id="fIndispensable"> Indispensable</label>

  <img id="coverPreview" class="cover-preview" style="display:none;">

  <div class="row"><button id="searchLinksBtn" class="ghost">Chercher les liens (Spotify / Deezer / Apple Music)</button></div>
  <div id="matchesSpotify" class="match-list"></div>
  <div id="matchesDeezer" class="match-list"></div>
  <div id="matchesApple" class="match-list"></div>

  <div class="row"><button id="addBtn">Ajouter à la file</button></div>
  <div id="addStatus" class="status"></div>
</div>
</div>

<div id="tab-queue" class="tab-panel">
<div class="card">
  <div class="row" style="margin-top:0;justify-content:space-between;align-items:center;">
    <strong style="font-size:14px;">File d'attente</strong>
    <button id="publishBtn" class="ghost small">Publier maintenant</button>
  </div>
  <div id="queueList" style="margin-top:10px;"></div>
  <div id="queueStatus" class="status"></div>
</div>
</div>

<div id="tab-wall" class="tab-panel">
<div class="wall-filters">
  <select id="wallStyleFilter"><option value="">Tous styles</option></select>
  <input type="text" id="wallSearchInput" placeholder="Chercher un artiste, un titre...">
</div>
<div id="wallContent"></div>
</div>

<script>
let selected = { spotify: null, deezer: null, apple: null };
let resolvedCover = "";
let entryType = "single";

const $ = (id) => document.getElementById(id);

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
    if(btn.dataset.tab === "wall") loadWall();
    if(btn.dataset.tab === "queue") loadQueue();
  });
});

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
    indispensable: $("fIndispensable").checked,
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
    $("fIndispensable").checked = false;
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
      "<div class='info'><div class='t'>" + (it.indispensable ? "★ " : "") + esc(it.artist) + " – " + esc(mainTitle) + "</div><div class='s'>" + (it.type === "album" ? "Album" : "Single") + (it.style?" · "+esc(it.style):"") + "</div></div>";
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
    $("queueStatus").textContent = data.publishedCount > 0
      ? "Publié ✓ (" + data.publishedCount + " son" + (data.publishedCount > 1 ? "s" : "") + ")"
      : "Rien à publier — la file était vide.";
  }catch(e){
    $("queueStatus").textContent = "Erreur lors de la publication — réessaie.";
  }
  loadQueue();
  wallCache = null;
}

function esc(s){
  return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ---------- mur public (lecture/édition/suppression) ----------
let wallCache = null;

async function loadWall(){
  const content = $("wallContent");
  if(wallCache === null){
    content.innerHTML = "<div class='empty'>Chargement...</div>";
    try{
      const res = await fetch("/wall");
      const data = await res.json();
      wallCache = data.wall || [];
    }catch(e){
      content.innerHTML = "<div class='empty'>Impossible de charger le mur pour le moment.</div>";
      return;
    }
    populateStyleFilter();
  }
  renderWall();
}

function populateStyleFilter(){
  const styles = new Set();
  wallCache.forEach((it) => { if(it.style) styles.add(it.style); });
  const sel = $("wallStyleFilter");
  const current = sel.value;
  sel.innerHTML = '<option value="">Tous styles</option>' +
    Array.from(styles).sort().map((s) => "<option value='"+esc(s)+"'>"+esc(s)+"</option>").join("");
  sel.value = current;
}

function wallCardHtml(it){
  const mainTitle = it.title || it.album || "(sans titre)";
  return "<div class='wall-card' data-id='" + it.id + "'>" +
    (it.cover ? "<img src='"+it.cover+"'>" : "") +
    "<div class='t'>" + (it.indispensable ? "★ " : "") + esc(it.artist) + " – " + esc(mainTitle) + "</div>" +
    "<div class='s'>" + (it.type === "album" ? "Album" : "Single") + (it.style ? " · " + esc(it.style) : "") + "</div>" +
    "<div class='actions'>" +
      "<button class='small ghost' data-action='indispensable'>" + (it.indispensable ? "★ Retirer" : "☆ Indispensable") + "</button>" +
      "<button class='small ghost' data-action='style'>Style</button>" +
      "<button class='small ghost' data-action='delete'>✕</button>" +
    "</div>" +
  "</div>";
}

$("wallContent").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if(!btn) return;
  const id = btn.closest(".wall-card").dataset.id;
  if(btn.dataset.action === "style") editWallStyle(id);
  if(btn.dataset.action === "delete") deleteWallItem(id);
  if(btn.dataset.action === "indispensable") toggleIndispensable(id);
});

async function toggleIndispensable(id){
  const it = wallCache.find((x) => x.id === id);
  if(!it) return;
  await fetch("/wall/" + id, { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ indispensable: !it.indispensable }) });
  wallCache = null;
  loadWall();
}

function renderWall(){
  const styleValue = $("wallStyleFilter").value;
  const query = $("wallSearchInput").value.trim().toLowerCase();
  const filtered = wallCache.filter((it) => {
    if(styleValue && it.style !== styleValue) return false;
    if(query){
      const haystack = (it.artist + " " + it.title + " " + (it.album||"")).toLowerCase();
      if(!haystack.includes(query)) return false;
    }
    return true;
  });
  const content = $("wallContent");
  if(!wallCache.length){
    content.innerHTML = "<div class='empty'>Rien de publié pour l'instant.</div>";
    return;
  }
  if(!filtered.length){
    content.innerHTML = "<div class='empty'>Rien ne correspond à ce filtre.</div>";
    return;
  }
  const weeks = [];
  const byWeek = {};
  filtered.forEach((it) => {
    const w = it.publishedWeek || "Sans date";
    if(!byWeek[w]){ byWeek[w] = []; weeks.push(w); }
    byWeek[w].push(it);
  });
  content.innerHTML = weeks.map((w) =>
    "<div class='wall-week-head'>Semaine du " + esc(w) + "</div>" +
    "<div class='wall-grid'>" + byWeek[w].map(wallCardHtml).join("") + "</div>"
  ).join("");
}

$("wallStyleFilter").addEventListener("change", renderWall);
$("wallSearchInput").addEventListener("input", renderWall);

async function editWallStyle(id){
  const it = wallCache.find((x) => x.id === id);
  if(!it) return;
  const style = prompt("Style pour " + it.artist + " – " + (it.title || it.album) + " :", it.style || "");
  if(style === null) return;
  await fetch("/wall/" + id, { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ style }) });
  wallCache = null;
  loadWall();
}

async function deleteWallItem(id){
  if(!confirm("Retirer ce son du mur public ?")) return;
  await fetch("/wall/" + id, { method:"DELETE" });
  wallCache = null;
  loadWall();
}

function populateStyleDatalist(){
  fetch("/wall").then(r => r.json()).then(data => {
    const styles = new Set();
    (data.wall || []).forEach((it) => { if(it.style) styles.add(it.style); });
    $("styleOptions").innerHTML = Array.from(styles).sort().map((s) => "<option value='"+esc(s)+"'>").join("");
  }).catch(() => {});
}

// pré-remplissage direct si arrivée via le Raccourci de partage (?shared=...)
const params = new URLSearchParams(location.search);
if(params.get("shared")){
  $("sharedUrl").value = params.get("shared");
  lookupSharedUrl();
}
loadQueue();
populateStyleDatalist();
</script>
</body>
</html>`;

// ---------- page minimaliste "ajout rapide" (hors Cloudflare Access) ----------
// même esprit que ADMIN_HTML mais réduite à l'essentiel (pas de publier, pas de
// supprimer, pas de réorganiser) — protégée uniquement par la clé secrète dans
// l'URL, jamais par la connexion email.
const QUICK_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ajout rapide — recos de la taupe</title>
<link rel="icon" type="image/png" href="data:image/png;base64,${FAVICON_B64}">
<style>
  :root{ --paper:#141210; --ink:#f2eee4; --ink-soft:#a89f8f; --card:#1e1b15; --line:#3a352c; }
  *{box-sizing:border-box;}
  body{ margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--paper); color:var(--ink); padding:16px 16px 60px; }
  h1{ font-size:17px; margin:0 0 14px; }
  .card{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
  label{ display:block; font-size:11.5px; color:var(--ink-soft); margin:10px 0 4px; text-transform:uppercase; letter-spacing:0.4px; }
  input, textarea{ width:100%; background:var(--paper); border:1px solid var(--line); border-radius:6px; padding:9px 10px; color:var(--ink); font-size:14px; font-family:inherit; }
  textarea{ min-height:60px; resize:vertical; }
  button{ background:var(--ink); color:var(--paper); border:none; border-radius:6px; padding:12px 14px; font-size:14.5px; font-weight:700; cursor:pointer; width:100%; margin-top:14px; }
  button:disabled{ opacity:0.5; }
  .type-btn{ background:transparent; color:var(--ink-soft); border:1px solid var(--line); width:auto; flex:1; margin-top:0; }
  .type-btn.active{ background:var(--ink); color:var(--paper); border-color:var(--ink); }
  .row{ display:flex; gap:8px; }
  .cover-preview{ width:100%; max-width:160px; aspect-ratio:1/1; object-fit:cover; border-radius:6px; margin-top:8px; background:var(--paper); border:1px solid var(--line); display:none; }
  .status{ font-size:13px; color:var(--ink-soft); margin-top:10px; min-height:16px; }
</style>
</head>
<body>

<h1>Ajout rapide — recos de la taupe</h1>

<div class="card">
  <label>Type</label>
  <div class="row">
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
  <textarea id="fNote"></textarea>

  <img id="coverPreview" class="cover-preview">

  <button id="addBtn">Ajouter à la file</button>
  <div id="status" class="status">Analyse du lien...</div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const KEY = params.get("key") || "";
const SHARED = params.get("shared") || "";
let entryType = "single";
let resolvedCover = "";
let links = { spotify: null, deezer: null, appleMusic: null };

function setEntryType(type){
  entryType = type;
  $("typeSingleBtn").classList.toggle("active", type === "single");
  $("typeAlbumBtn").classList.toggle("active", type === "album");
  $("titleLabel").textContent = type === "album" ? "Titre (optionnel pour un album)" : "Titre";
}
$("typeSingleBtn").addEventListener("click", () => setEntryType("single"));
$("typeAlbumBtn").addEventListener("click", () => setEntryType("album"));

function showCover(url){
  if(!url) return;
  resolvedCover = url;
  const img = $("coverPreview");
  img.src = url;
  img.style.display = "block";
}

async function searchDeezer(q){
  if(!q) return;
  return new Promise((resolve) => {
    const cbName = "molecb" + Date.now();
    window[cbName] = (data) => {
      const best = (data.data || [])[0];
      if(best){
        links.deezer = best.link;
        if(!resolvedCover && best.album) showCover(best.album.cover_medium);
      }
      delete window[cbName];
      script.remove();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://api.deezer.com/search?q=" + encodeURIComponent(q) + "&output=jsonp&callback=" + cbName;
    script.onerror = () => resolve();
    document.body.appendChild(script);
    setTimeout(resolve, 4000);
  });
}

async function resolveShared(){
  if(!SHARED){ $("status").textContent = "Aucun lien reçu — remplis les champs à la main."; return; }
  try{
    if(SHARED.includes("music.apple.com")){
      let appleId = null;
      const u = new URL(SHARED);
      const iParam = u.searchParams.get("i");
      if(iParam && /^[0-9]+$/.test(iParam)){
        appleId = iParam;
      } else {
        const segments = u.pathname.split("/").filter(Boolean);
        const last = segments[segments.length - 1];
        if(last && /^[0-9]+$/.test(last)) appleId = last;
      }
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
          showCover((t.artworkUrl100 || "").replace("100x100bb", "600x600bb"));
          links.appleMusic = t.trackViewUrl || t.collectionViewUrl || null;
        }
      }
    }
    const artist = $("fArtist").value.trim();
    const title = $("fTitle").value.trim();
    const album = $("fAlbum").value.trim();
    const q = (artist + " " + (title || album)).trim();
    if(q) await searchDeezer(q);
    $("status").textContent = artist ? "Vérifie les champs, puis ajoute." : "Rien trouvé automatiquement — remplis à la main.";
  }catch(e){
    $("status").textContent = "Impossible d'analyser ce lien — remplis les champs à la main.";
  }
}

$("addBtn").addEventListener("click", async () => {
  const artist = $("fArtist").value.trim();
  const title = $("fTitle").value.trim();
  const album = $("fAlbum").value.trim();
  if(!artist || (!title && !album)){
    $("status").textContent = "Artiste obligatoire, plus au moins Titre ou Album.";
    return;
  }
  $("addBtn").disabled = true;
  $("status").textContent = "Ajout...";
  try{
    const res = await fetch("/quick/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: KEY,
        artist, title, album,
        type: entryType,
        date: $("fDate").value.trim(),
        style: $("fStyle").value.trim(),
        note: $("fNote").value.trim(),
        cover: resolvedCover,
        links
      })
    });
    if(!res.ok) throw new Error("failed");
    $("status").textContent = "Ajouté à la file ✓ — tu peux fermer cette page.";
  }catch(e){
    $("status").textContent = "Erreur lors de l'ajout — réessaie.";
    $("addBtn").disabled = false;
  }
});

resolveShared();
</script>
</body>
</html>`;
