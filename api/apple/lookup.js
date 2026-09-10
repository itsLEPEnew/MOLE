import { handleAppleLookup, corsHeaders } from "../../lib/mole-public-core.js";

export const config = { runtime: "edge" };

export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
  return handleAppleLookup(new URL(request.url));
}
