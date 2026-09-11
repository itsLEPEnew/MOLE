/**
 * Proxy de chat pour "la Taupe" — remplace mole-chat-proxy-worker sur Cloudflare.
 *
 * Toute la logique est dans lib/mole-chat-core.js (port fidèle du Worker) : ce fichier ne
 * fait que l'exposer sur /chat via la réécriture déclarée dans vercel.json.
 */
import { handleChatRequest } from "../lib/mole-chat-core.js";

export const config = { runtime: "edge" };

export default async function handler(request) {
  return handleChatRequest(request);
}
