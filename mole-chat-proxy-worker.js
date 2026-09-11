/**
 * Proxy pour le chatbot "la Taupe" — à déployer sur Cloudflare Workers (gratuit).
 *
 * Tourne sur Cloudflare Workers AI (binding "AI") plutôt que sur l'API Gemini externe :
 * pas de clé API à gérer/protéger, et l'inférence tourne sur la même infra que le Worker
 * lui-même (edge Cloudflare), donc une latence beaucoup plus stable que la file d'attente
 * du tier gratuit de Google constatée avec Gemini. Le modèle est Mistral Small 3.1 (24B) :
 * un 3B (Granite 4.0 H-Micro) a d'abord été essayé, mais il ne tenait pas la consigne de
 * refus hors-sujet — il donnait volontiers une recette de risotto ou des conseils
 * juridiques. Mesuré sur 5 sujets hors-sujet : 2/5 de refus pour le 3B, 5/5 pour celui-ci,
 * personnage préservé, au prix de quelques secondes de latence supplémentaires.
 * Son API est compatible OpenAI (messages/choices/tool_calls), pas le format Gemini.
 *
 * La Taupe peut aussi AGIR dans l'app (chercher/ouvrir une fiche, noter, lancer Terrain
 * vague/La Piste) via le function calling : ce Worker déclare les outils et relaie les
 * allers-retours, mais ne les EXÉCUTE jamais lui-même — l'exécution (ouvrir une fiche,
 * écrire dans le localStorage du visiteur) ne peut avoir lieu que dans son navigateur. Voir
 * le contrat exact dans index.html (buildChatContext/executeChatTool/sendChatMessage).
 *
 * Déploiement (~5 minutes, rien à payer, aucune clé à créer) :
 * 1. Crée un compte sur https://dash.cloudflare.com (gratuit)
 * 2. Workers & Pages > Create > Create Worker, colle ce code, déploie une première fois.
 * 3. Sur CE Worker : Settings > Bindings > Add > Workers AI.
 *    Variable name : AI (exactement ce nom, en majuscules) — aucune configuration
 *    supplémentaire nécessaire, pas de clé, pas de compte externe.
 * 4. Redéploie. Tu obtiens une URL du style https://mole-chat.ton-compte.workers.dev
 * 5. Colle cette URL dans CHAT_PROXY_URL en haut du <script> de index.html
 *
 * Quota gratuit : 10 000 "Neurons" (unité de calcul Cloudflare) par jour, partagés entre
 * tous les modèles utilisés sur le compte — largement suffisant pour un chat perso avec un
 * petit modèle comme celui-ci. Au-delà, facturation à l'usage (pas de coupure surprise).
 */

const MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";

const SYSTEM_INSTRUCTION = `Tu es la Taupe de MOLE, la mascotte du site. Tu es espiègle, chaleureuse, un peu taquine, passionnée de musique, et tu adores creuser des tunnels pour dénicher des pépites musicales.

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
const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_and_open_album",
      description: "Cherche un artiste/album/single dans le vrai catalogue MOLE et ouvre sa fiche (cover, tracklist, liens d'écoute) directement dans l'app. À utiliser TOUJOURS avant de présenter une recommandation précise à l'utilisateur — jamais de nom d'album sans passer par cet outil.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Termes de recherche : nom d'artiste seul, ou \"artiste titre\" UNIQUEMENT si l'utilisateur a nommé un album précis ou si tu es sûre qu'il existe. N'invente jamais un titre d'album pour compléter la requête : un titre inventé ne renvoie aucun résultat et fait échouer la recherche. Dans le doute, cherche le nom d'artiste seul." },
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }

    if (!env.AI) {
      return jsonResponse({ error: "Le binding Workers AI (variable \"AI\") n'est pas configuré sur ce Worker — voir Settings > Bindings." }, 500);
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
      ai = await env.AI.run(MODEL, { messages, tools: TOOLS, max_tokens: 400, temperature: 0.8 });
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
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
