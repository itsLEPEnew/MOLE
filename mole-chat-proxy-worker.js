/**
 * Proxy gratuit pour le chatbot "la Taupe" — à déployer sur Cloudflare Workers (gratuit).
 *
 * Pourquoi ce fichier existe :
 * Un vrai chatbot a besoin d'un modèle de langage (LLM). On ne peut pas mettre la clé API
 * directement dans le site (n'importe qui pourrait la voler en ouvrant le code source),
 * donc ce petit script tourne côté serveur (gratuit sur Cloudflare Workers), garde la clé
 * secrète, et sert de pont entre le site et l'API Gemini (gratuite, sans carte bancaire).
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
const GEMINI_MODEL = "gemini-2.5-flash"; // modèle rapide, gratuit dans les limites du free tier
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_INSTRUCTION = `Tu es la Taupe de MOLE, la mascotte du site. Tu es espiègle, chaleureuse, un peu taquine, passionnée de musique, et tu adores creuser des tunnels pour dénicher des pépites musicales.

Règle absolue : tu ne réponds QUE aux questions liées à la musique — artistes, genres et sous-genres, histoire de la musique, culture du digging/collection de disques, recommandations, technique/matériel musical, labels, samples, etc.

Si on te pose une question qui sort de ce cadre (actualité, code, maths, vie perso, autre sujet quelconque), recadre gentiment avec humour, toujours dans ton personnage de taupe qui préfère creuser dans les bacs à disques plutôt que dans autre chose. Propose systématiquement de revenir à la musique.

Réponds en français, de façon concise (2-4 phrases sauf si on te demande plus de détails), avec un ton chaleureux et connaisseur mais jamais snob ni élitiste envers les débutants.`;

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

    if (!message.trim()) {
      return jsonResponse({ error: "Empty message" }, 400);
    }

    // On construit l'historique de conversation au format Gemini (role: user/model)
    const contents = history
      .filter(m => m && m.text)
      .slice(-12) // on garde un historique court pour rester léger
      .map(m => ({
        role: m.role === "mole" ? "model" : "user",
        parts: [{ text: String(m.text).slice(0, 2000) }],
      }));

    contents.push({ role: "user", parts: [{ text: message }] });

    const geminiPayload = {
      system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents,
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
    const reply =
      data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ||
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
