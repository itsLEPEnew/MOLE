// VERSION DIAGNOSTIC TEMPORAIRE — teste plusieurs formats d'appel à env.AI.run() en un seul
// coup pour trouver lequel passe, au lieu de redéployer à chaque essai. À remplacer par la
// vraie version dès que le format qui marche est identifié.

const MODEL = "@cf/ibm-granite/granite-4.0-h-micro";

const TOOLS = [
  {
    name: "search_and_open_album",
    description: "Cherche un artiste/album dans le catalogue et ouvre sa fiche.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Termes de recherche." } },
      required: ["query"],
    },
  },
];

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    const attempts = [
      {
        label: "messages simple, sans tools",
        payload: { messages: [{ role: "user", content: "Dis bonjour en un mot." }] },
      },
      {
        label: "messages + system, sans tools",
        payload: { messages: [{ role: "system", content: "Tu es bref." }, { role: "user", content: "Dis bonjour en un mot." }] },
      },
      {
        label: "messages + tools",
        payload: { messages: [{ role: "user", content: "Cherche l'album Discovery de Daft Punk." }], tools: TOOLS },
      },
      {
        label: "messages + tools + max_tokens/temperature",
        payload: { messages: [{ role: "user", content: "Cherche l'album Discovery de Daft Punk." }], tools: TOOLS, max_tokens: 200, temperature: 0.8 },
      },
    ];

    const results = [];
    for (const a of attempts) {
      try {
        const res = await env.AI.run(MODEL, a.payload);
        results.push({ label: a.label, ok: true, result: res });
      } catch (e) {
        results.push({ label: a.label, ok: false, error: String(e && e.message || e) });
      }
    }

    return jsonResponse({ results });
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
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
