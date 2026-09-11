/**
 * Point d'entrée unique de l'admin sur Vercel.
 *
 * vercel.json réécrit /admin/:path* vers ce fichier, en passant le chemin d'origine dans
 * le paramètre "path". On reconstruit donc une requête dont le pathname est celui qu'attend
 * le code porté (/queue, /wall/<id>, /quick…), ce qui permet de garder son routage interne
 * strictement identique à celui du Worker Cloudflare.
 */
import { handleAdminRequest } from "../lib/mole-admin-core.js";
import { buildAdminEnv } from "../lib/mole-admin-env.js";

export const config = { runtime: "edge" };

export default async function handler(request) {
  const incoming = new URL(request.url);
  const path = incoming.searchParams.get("path") || "";
  incoming.searchParams.delete("path"); // paramètre ajouté par la réécriture, pas par le client

  const target = new URL(incoming.toString());
  target.pathname = "/" + path;

  const isBodyless = request.method === "GET" || request.method === "HEAD";
  const proxied = new Request(target.toString(), {
    method: request.method,
    headers: request.headers,
    body: isBodyless ? undefined : await request.text(),
  });

  return handleAdminRequest(proxied, buildAdminEnv());
}
