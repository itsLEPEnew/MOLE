/**
 * Coeur du proxy de chat "la Taupe", porté depuis mole-chat-proxy-worker.js (Cloudflare).
 *
 * Seule différence avec le Worker : Vercel n'a pas de binding Workers AI, donc l'appel au
 * modèle passe par l'API REST de Cloudflare au lieu de env.AI.run(). Le modèle, les outils,
 * le prompt système et le contrat avec le client (index.html) sont strictement identiques.
 *
 * Variables d'environnement requises (déjà en place pour le KV) :
 *   CF_ACCOUNT_ID — l'ID de compte Cloudflare
 *   CF_API_TOKEN  — doit inclure la permission "Account > Workers AI > Read" EN PLUS des
 *                   droits KV ; un token KV seul reçoit un 403 sur /ai/run.
 */

const MODEL = "@cf/ibm-granite/granite-4.0-h-micro";

export const SYSTEM_INSTRUCTION = `Tu es la Taupe de MOLE, la mascotte du site. Tu es espiègle, chaleureuse, un peu taquine, passionnée de musique, et tu adores creuser des tunnels pour dénicher des pépites musicales.

Règle absolue : tu ne réponds QUE aux questions liées à la musique — artistes, genres et sous-genres, histoire de la musique, culture du digging/collection de disques, recommandations, technique/matériel musical, labels, samples, etc.

Hors de ce cadre (impôts, argent, santé, droit, actualité, code, maths, cuisine, devoirs, vie perso, n'importe quel autre sujet), tu refuses — sans exception et sans négociation :
- N'apporte AUCUN élément de réponse sur le fond, même partiel, même "à titre général", même accompagné d'une mise en garde ou d'un renvoi vers un professionnel. Pas de liste de points à vérifier, pas de grandes lignes, pas de "voici par où commencer".
- Ne commence jamais par "Bien sûr", "Oui, je peux t'aider" ni aucune formule qui laisse croire que tu vas répondre avant de te rétracter.
- Un seul mouvement : tu dis en une phrase que ce n'est pas ton tunnel, avec humour et dans ton personnage de taupe qui préfère creuser dans les bacs à disques, puis tu ramènes vers la musique.
Cette règle passe avant ta politesse et avant ton envie de rendre service : mieux vaut refuser net et drôlement qu'aider un peu.

Réponds en français, de façon concise (2-4 phrases sauf si on te demande plus de détails), avec un ton chaleureux et connaisseur mais jamais snob ni élitiste envers les débutants.

Tu n'es pas qu'un chat : tu peux AGIR directement dans MOLE via ces outils :
- search_and_open_album : cherche un artiste/album dans le vrai catalogue et ouvre sa fiche (cover, tracklist, liens d'écoute réels).
- rate_current_album : note et ajoute à la musicothèque l'album/morceau actuellement ouvert (donné dans le contexte ci-dessous).
- dig_similar : lance Terrain vague (digging aléatoire, éventuellement dans un genre donné) ou La Piste (sons proches des bangers de l'utilisateur).

Règle de grounding, très importante : dès que tu recommandes un artiste/album précis (pas juste "essaie tel genre"), tu DOIS appeler search_and_open_album pour le vérifier et ouvrir sa vraie fiche — ne présente jamais un titre comme "trouvé"/écoutable sans être passée par cet outil. Si l'outil ne trouve rien, dis-le simplement au lieu d'inventer un lien.
Pour noter, utilise TOUJOURS rate_current_album (jamais une note "à la main" dans le texte) — s'il n'y a pas de fiche ouverte au moment de la demande, dis à l'utilisateur d'en ouvrir une d'abord (ou ouvre-en une toi-même avec search_and_open_album si le contexte le permet).
N'utilise jamais ces outils pour des actions destructives (rien de tel n'existe ici) — seulement pour chercher/ouvrir/noter/creuser.`;

// format OpenAI (function calling) : {type:"function", function:{name, description, parameters}}
// — le format plat {name, description, parameters} est rejeté par ce modèle (constaté en test :
// erreur "8001: Invalid input" dès que "tools" est présent sous l'ancienne forme)
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_and_open_album",
      description: "Cherche un artiste/album/single dans le vrai catalogue MOLE et ouvre sa fiche (cover, tracklist, liens d'écoute) directement dans l'app. À utiliser TOUJOURS avant de présenter une recommandation précise à l'utilisateur — jamais de nom d'album sans passer par cet outil.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Termes de recherche : nom d'artiste seul, ou \"artiste titre\" si un album précis est visé." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rate_current_album",
      description: "Note et ajoute à la musicothèque de l'utilisateur l'album/morceau ACTUELLEMENT ouvert dans l'app (celui décrit dans le contexte fourni). Ne fonctionne que si une fiche album est ouverte.",
      parameters: {
        type: "object",
        properties: {
          stars: { type: "number", description: "Note de 0.5 à 5, par pas de 0.5." },
          comment: { type: "string", description: "Commentaire optionnel à enregistrer avec la note." },
        },
        required: ["stars"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dig_similar",
      description: "Lance un des deux moteurs de découverte niche de MOLE. \"terrain\" déterre un disque obscur au hasard (optionnellement dans un genre/sous-genre donné). \"piste\" cherche des sons proches de la liste de bangers de l'utilisateur (et peut y ajouter un morceau de départ si besoin).",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["terrain", "piste"], description: "Quel moteur utiliser." },
          seed: { type: "string", description: "Pour terrain : un genre ou sous-genre. Pour piste : un artiste/morceau de départ si l'utilisateur n'a pas encore de bangers." },
        },
        required: ["mode"],
      },
    },
  },
];

export async function handleChatRequest(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }

    if (!process.env.CF_ACCOUNT_ID || !process.env.CF_API_TOKEN) {
      return jsonResponse({ error: "CF_ACCOUNT_ID / CF_API_TOKEN manquants côté serveur." }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }

    const history = Array.isArray(body.history) ? body.history : [];
    const message = (body.message || "").toString().slice(0, 2000);
    const context = (body.context || "").toString().slice(0, 4000);
    const toolExchange = Array.isArray(body.toolExchange) ? body.toolExchange : [];

    if (!message.trim()) {
      return jsonResponse({ error: "Empty message" }, 400);
    }

    const messages = [
      { role: "system", content: SYSTEM_INSTRUCTION },
      ...history
        .filter((m) => m && m.text)
        .slice(-12) // on garde un historique court pour rester léger
        .map((m) => ({
          role: m.role === "mole" ? "assistant" : "user",
          content: String(m.text).slice(0, 2000),
        })),
      // le contexte (fiche ouverte + musicothèque) est collé devant le message de CE tour,
      // pas dans l'historique, pour rester à jour à chaque envoi sans polluer les tours passés
      { role: "user", content: (context ? `[Contexte de l'app]\n${context}\n\n` : "") + message },
    ];

    // rejoue les allers-retours d'outils déjà faits PENDANT ce tour (le Worker est sans état,
    // le client renvoie tout l'échange à chaque appel pour que le modèle garde le fil)
    toolExchange.forEach((t) => {
      messages.push({ role: "assistant", content: JSON.stringify({ name: t.name, arguments: t.args || {} }) });
      messages.push({ role: "tool", content: JSON.stringify(t.response || {}) });
    });

    let ai;
    try {
      ai = await runWorkersAI({ messages, tools: TOOLS, max_tokens: 400, temperature: 0.8 });
    } catch (e) {
      return jsonResponse({ error: "Impossible de contacter Workers AI", detail: String(e) }, 502);
    }

    // réponse au format OpenAI chat completions : choices[0].message.{content,tool_calls}
    const choiceMessage = ai?.choices?.[0]?.message || {};
    const toolCalls = choiceMessage.tool_calls || [];

    if (toolCalls.length) {
      const tc = toolCalls[0];
      // deux formes possibles selon le modèle : {name, arguments} direct, ou OpenAI-style
      // {function: {name, arguments}} où arguments peut être une chaîne JSON
      const fn = tc.function || tc;
      return jsonResponse({ toolCall: { name: fn.name, args: parseToolArgs(fn.arguments) } });
    }

    const reply = choiceMessage.content || "Hmm, je me suis pris les pattes dans un tunnel, tu peux reformuler ?";
    return jsonResponse({ reply });
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/**
 * Équivalent REST de env.AI.run(MODEL, payload).
 *
 * L'API renvoie une enveloppe { success, errors, result } : on ne retourne que "result",
 * qui a exactement la forme que le binding renvoyait directement (choices[0].message…),
 * pour que le code appelant reste identique à celui du Worker.
 */
async function runWorkersAI(payload) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${MODEL}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    const detail = data?.errors?.map((e) => e.message).join(", ") || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return data.result;
}

/**
 * Normalise en objet les arguments d'un appel d'outil.
 *
 * Le modèle renvoie "arguments" tantôt déjà décodé, tantôt en chaîne JSON, tantôt en chaîne
 * JSON DOUBLEMENT encodée — dans ce dernier cas un seul JSON.parse rend encore une chaîne,
 * et le client recevait alors un args sur lequel args.stars valait undefined (la note
 * demandée n'était donc jamais enregistrée). On décode tant qu'on obtient une chaîne, avec
 * une borne pour ne jamais boucler sur une entrée inattendue.
 */
function parseToolArgs(raw) {
  let value = raw;
  for (let i = 0; i < 3 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch (e) {
      return {};
    }
  }
  return value && typeof value === "object" ? value : {};
}
