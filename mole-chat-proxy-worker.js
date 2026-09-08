/**
 * Proxy gratuit pour le chatbot "la Taupe" — à déployer sur Cloudflare Workers (gratuit).
 *
 * Pourquoi ce fichier existe :
 * Un vrai chatbot a besoin d'un modèle de langage (LLM). On ne peut pas mettre la clé API
 * directement dans le site (n'importe qui pourrait la voler en ouvrant le code source),
 * donc ce petit script tourne côté serveur (gratuit sur Cloudflare Workers), garde la clé
 * secrète, et sert de pont entre le site et l'API Gemini (gratuite, sans carte bancaire).
 *
 * La Taupe peut aussi AGIR dans l'app (chercher/ouvrir une fiche, noter, lancer Terrain
 * vague/La Piste) via le function calling de Gemini : ce Worker déclare les outils et relaie
 * les allers-retours, mais ne les EXÉCUTE jamais lui-même — l'exécution (ouvrir une fiche,
 * écrire dans le localStorage du visiteur) ne peut avoir lieu que dans son navigateur. Voir
 * le contrat exact dans index.html (buildChatContext/executeChatTool/sendChatMessage).
 *
 * Déploiement (gratuit, ~5 minutes) :
 * 1. Crée une clé API gratuite sur https://aistudio.google.com/apikey (compte Google, pas de CB)
 * 2. Crée un compte sur https://dash.cloudflare.com (gratuit)
 * 3. Workers & Pages > Create > Create Worker
 * 4. Colle ce code, remplace GEMINI_API_KEY par ta clé
 * 5. Déploie, tu obtiens une URL du style https://mole-chat.ton-compte.workers.dev
 * 6. Colle cette URL dans CHAT_PROXY_URL en haut du <script> de index.html
 */

const GEMINI_API_KEY = "REMPLACE_PAR_TA_CLE_GRATUITE";
const GEMINI_MODEL = "gemini-2.5-flash"; // modèle rapide, gratuit dans les limites du free tier, supporte le function calling
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_INSTRUCTION = `Tu es la Taupe de MOLE, la mascotte du site. Tu es espiègle, chaleureuse, un peu taquine, passionnée de musique, et tu adores creuser des tunnels pour dénicher des pépites musicales.

Règle absolue : tu ne réponds QUE aux questions liées à la musique — artistes, genres et sous-genres, histoire de la musique, culture du digging/collection de disques, recommandations, technique/matériel musical, labels, samples, etc.

Si on te pose une question qui sort de ce cadre (actualité, code, maths, vie perso, autre sujet quelconque), recadre gentiment avec humour, toujours dans ton personnage de taupe qui préfère creuser dans les bacs à disques plutôt que dans autre chose. Propose systématiquement de revenir à la musique.

Réponds en français, de façon concise (2-4 phrases sauf si on te demande plus de détails), avec un ton chaleureux et connaisseur mais jamais snob ni élitiste envers les débutants.

Tu n'es pas qu'un chat : tu peux AGIR directement dans MOLE via ces outils :
- search_and_open_album : cherche un artiste/album dans le vrai catalogue et ouvre sa fiche (cover, tracklist, liens d'écoute réels).
- rate_current_album : note et ajoute à la musicothèque l'album/morceau actuellement ouvert (donné dans le contexte ci-dessous).
- dig_similar : lance Terrain vague (digging aléatoire, éventuellement dans un genre donné) ou La Piste (sons proches des bangers de l'utilisateur).

Règle de grounding, très importante : dès que tu recommandes un artiste/album précis (pas juste "essaie tel genre"), tu DOIS appeler search_and_open_album pour le vérifier et ouvrir sa vraie fiche — ne présente jamais un titre comme "trouvé"/écoutable sans être passée par cet outil. Si l'outil ne trouve rien, dis-le simplement au lieu d'inventer un lien.
Pour noter, utilise TOUJOURS rate_current_album (jamais une note "à la main" dans le texte) — s'il n'y a pas de fiche ouverte au moment de la demande, dis à l'utilisateur d'en ouvrir une d'abord (ou ouvre-en une toi-même avec search_and_open_album si le contexte le permet).
N'utilise jamais ces outils pour des actions destructives (rien de tel n'existe ici) — seulement pour chercher/ouvrir/noter/creuser.`;

const TOOLS = [
  {
    name: "search_and_open_album",
    description: "Cherche un artiste/album/single dans le vrai catalogue MOLE et ouvre sa fiche (cover, tracklist, liens d'écoute) directement dans l'app. À utiliser TOUJOURS avant de présenter une recommandation précise à l'utilisateur — jamais de nom d'album sans passer par cet outil.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Termes de recherche : nom d'artiste seul, ou \"artiste titre\" si un album précis est visé." },
      },
      required: ["query"],
    },
  },
  {
    name: "rate_current_album",
    description: "Note et ajoute à la musicothèque de l'utilisateur l'album/morceau ACTUELLEMENT ouvert dans l'app (celui décrit dans le contexte fourni). Ne fonctionne que si une fiche album est ouverte.",
    parameters: {
      type: "OBJECT",
      properties: {
        stars: { type: "NUMBER", description: "Note de 0.5 à 5, par pas de 0.5." },
        comment: { type: "STRING", description: "Commentaire optionnel à enregistrer avec la note." },
      },
      required: ["stars"],
    },
  },
  {
    name: "dig_similar",
    description: "Lance un des deux moteurs de découverte niche de MOLE. \"terrain\" déterre un disque obscur au hasard (optionnellement dans un genre/sous-genre donné). \"piste\" cherche des sons proches de la liste de bangers de l'utilisateur (et peut y ajouter un morceau de départ si besoin).",
    parameters: {
      type: "OBJECT",
      properties: {
        mode: { type: "STRING", enum: ["terrain", "piste"], description: "Quel moteur utiliser." },
        seed: { type: "STRING", description: "Pour terrain : un genre ou sous-genre. Pour piste : un artiste/morceau de départ si l'utilisateur n'a pas encore de bangers." },
      },
      required: ["mode"],
    },
  },
];

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
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

    // Historique de conversation (tours précédents, texte uniquement) au format Gemini
    const contents = history
      .filter((m) => m && m.text)
      .slice(-12) // on garde un historique court pour rester léger
      .map((m) => ({
        role: m.role === "mole" ? "model" : "user",
        parts: [{ text: String(m.text).slice(0, 2000) }],
      }));

    // le contexte (fiche ouverte + musicothèque) est collé devant le message de CE tour,
    // pas dans l'historique, pour rester à jour à chaque envoi sans polluer les tours passés
    contents.push({
      role: "user",
      parts: [{ text: (context ? `[Contexte de l'app]\n${context}\n\n` : "") + message }],
    });

    // rejoue les allers-retours d'outils déjà faits PENDANT ce tour (le Worker est sans état,
    // le client renvoie tout l'échange à chaque appel pour que Gemini garde le fil)
    toolExchange.forEach((t) => {
      contents.push({ role: "model", parts: [{ functionCall: { name: t.name, args: t.args || {} } }] });
      contents.push({ role: "user", parts: [{ functionResponse: { name: t.name, response: t.response || {} } }] });
    });

    const geminiPayload = {
      system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents,
      tools: [{ function_declarations: TOOLS }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 400,
      },
    };

    let geminiRes;
    try {
      geminiRes = await fetch(GEMINI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify(geminiPayload),
      });
    } catch (e) {
      return jsonResponse({ error: "Impossible de contacter Gemini" }, 502);
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return jsonResponse({ error: "Gemini API error", detail: errText }, geminiRes.status);
    }

    const data = await geminiRes.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const fnCallPart = parts.find((p) => p.functionCall);

    if (fnCallPart) {
      return jsonResponse({ toolCall: { name: fnCallPart.functionCall.name, args: fnCallPart.functionCall.args || {} } });
    }

    const reply =
      parts.map((p) => p.text).filter(Boolean).join("") ||
      "Hmm, je me suis pris les pattes dans un tunnel, tu peux reformuler ?";

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
