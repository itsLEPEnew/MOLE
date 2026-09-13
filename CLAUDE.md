# MOLE

PWA française de découverte musicale (digging), animée par une mascotte-taupe ("la Taupe").
Un seul fichier front-end (`index.html`, ~6000 lignes, HTML/CSS/JS inline, aucun build).
Backend en Vercel Edge Functions (`api/`). Repo GitHub public : `itsLEPEnew/MOLE`.

**Dernière mise à jour de ce fichier : 14/09/2026.**

## Architecture actuelle

- **Hébergement** : Vercel (`mole-mole4.vercel.app`), déploie automatiquement depuis `main`.
- **Données persistantes** (file d'attente, mur publié, abonnements push) : **Supabase**
  (Postgres), tables `recos_queue`, `recos_wall`, `push_subscriptions`. Pont REST dans
  `lib/supabase-db.js` — mêmes noms de champs que l'ancien KV, donc `index.html` et l'admin
  n'ont rien eu à changer.
- **Catalogue musical** (recherche, tracklists) : Supabase aussi, tables `catalog_artists` /
  `catalog_albums`. Voir `lib/mole-catalog.js`. **En cours, sur la branche `catalog`, pas
  fusionnée** — voir "Chantier en cours" plus bas.
- **Cache éphémère** (recherches iTunes/Deezer, TTL courte) : Cloudflare KV, via
  `lib/cloudflare-kv.js`. Ne stocke rien d'important, juste pour accélérer des requêtes
  répétées à court terme.
- **IA du chat** : Cloudflare Workers AI (modèle Mistral Small 3.1 24B — un modèle 3B a été
  essayé, ne tenait pas la consigne de refus hors-sujet). Proxy dans `lib/mole-chat-core.js`.
- **Notifications push** : VAPID, envoyées le vendredi matin par un cron Vercel
  (`api/cron/friday.js`) qui publie la file d'attente vers le mur.
- **Anciens Workers Cloudflare** (public, admin, chat) : **désactivés** depuis le 12/09/2026
  (route workers.dev coupée dans le dashboard). Ne plus les réactiver — ils écriraient dans
  l'ancien KV, invisible du reste du système.

## Fichiers clés

| Fichier | Rôle |
|---|---|
| `index.html` | Tout le front-end |
| `lib/mole-public-core.js` | Recherche, tracklists, lecture du mur public |
| `lib/mole-admin-core.js` | Admin (file d'attente, publication, GIF) — copie fidèle de l'ancien Worker |
| `lib/mole-chat-core.js` | Proxy de la Taupe (Workers AI) |
| `lib/supabase-db.js` | Pont REST pour queue/wall/push_subscriptions |
| `lib/mole-catalog.js` | Pont REST pour le catalogue musical (branche `catalog`) |
| `lib/cloudflare-kv.js` | Cache éphémère uniquement |
| `api/cron/friday.js` | Publication + push du vendredi |
| `api/cron/catalog.js` | Pré-charge quotidienne des nouveautés (branche `catalog`) |
| `vercel.json` | Rewrites + crons |
| `design-system/` | Dossier de composants extraits pour Claude Design (pas versionné dans git — `.gitignore`) |

## Pièges déjà rencontrés (pour ne pas les re-découvrir)

- **Le service worker cache agressivement `index.html`.** Après un déploiement, un onglet de
  test peut afficher l'ancienne version. Pour vérifier une preview : vider les caches et
  désinscrire le service worker via `navigator.serviceWorker.getRegistrations()` /
  `caches.keys()` avant de recharger.
- **Les URLs d'API sont en `location.origin`**, pas en dur — chaque déploiement (prod ou
  preview) parle à sa propre API. Ne jamais remettre une URL Vercel en dur dans `index.html`.
- **Variables d'environnement Vercel** : cocher Production **et** Preview sur chacune, sinon
  une branche de test échoue sans raison évidente (repéré avec `QUICK_ADD_SECRET`,
  `CRON_SECRET`...). Un changement de portée n'est pris en compte qu'au prochain déploiement
  — un commit vide suffit à le déclencher.
- **MusicBrainz plafonne à 1 requête/seconde par IP**, répond 503 au-delà. Ne jamais l'appeler
  depuis le navigateur du visiteur (c'était le cas avant le 12/09) — toujours depuis le
  serveur, avec cache et réessai (voir `mbFetch` dans `mole-public-core.js`).
- **L'API Wikimedia exige un User-Agent identifiant**, sinon bloque silencieusement les
  artistes sans lien Wikipédia direct (repéré sur Radiohead, qui n'a qu'un lien Wikidata).
- **Deezer renvoie une URL de photo même sans photo réelle** (empreinte vide, `/artist//`
  dans l'URL) — toujours vérifier avant d'afficher.
- **Les durées Deezer sont en secondes**, le front attend des millisecondes
  (`formatDuration`). Convertir à la lecture, pas au stockage.
- **`git add -A` est dangereux ici** : le dossier de travail contient parfois des fichiers
  personnels hors repo (ex. `TOKEN IPHONE.pdf`). Un `.gitignore` existe déjà, mais rester
  vigilant avant tout `git add -A`.
- **Ne jamais committer de vraie clé/secret.** Toujours des placeholders
  (`REMPLACE_PAR_...`) dans le code, les vraies valeurs seulement dans les variables
  d'environnement Vercel/Cloudflare/Supabase.

## Secrets déjà en place (valeurs dans les dashboards, pas ici)

Vercel : `QUICK_ADD_SECRET`, `GIPHY_API_KEY`, `VAPID_PRIVATE_KEY_JWK`, `VAPID_SUBJECT`,
`CRON_SECRET`, `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`, `CF_API_TOKEN`, `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`. `CF_API_TOKEN` doit avoir la permission Workers AI (pas juste KV).

## Chantier en cours : catalogue musical (branche `catalog`)

**But** : que la recherche interroge notre propre base (Supabase) au lieu de Deezer/iTunes à
chaque frappe, et que les tracklists soient stockées à l'ingestion (fini le "chargement en
cours"). Toute recherche qui ne trouve rien en base va chercher chez Deezer et écrit le
résultat au passage — le catalogue s'enrichit tout seul de ce que la communauté cherche.

**Fait et vérifié** :
- Tables `catalog_artists` / `catalog_albums` créées et peuplées automatiquement
- Tracklists servies depuis la base, avec durées et extraits audio 30s, zéro appel réseau
- Job quotidien (`api/cron/catalog.js`) écrit, deux crons acceptés par le forfait Vercel gratuit
- Bug corrigé : double récupération des détails d'album (24 appels au lieu de 12)
- Bug corrigé : durées affichées à 0:00 (secondes vs millisecondes)

**Pas encore réglé — à traiter avant de fusionner** :
- Le gain de latence annoncé (~30ms) n'est pas au rendez-vous : mesuré à ~360-400ms côté
  serveur pour une recherche catalogue, à peine mieux que Deezer direct. Hypothèse la plus
  probable : les fonctions Edge tournent réparties dans le monde alors que Supabase est dans
  une seule région — chaque requête traverse la planète. À vérifier : passer les routes
  `api/apple/*` en runtime Node avec une région fixe proche de Supabase, ou `export const
  config = { runtime: "edge", regions: [...] }` si Vercel le permet pour edge.
- Pas encore fusionné sur `main`. Reprendre par : relancer les mesures de latence après
  correction régionale, tester le job quotidien avec de vraies données, puis fusionner.

## Autres chantiers connus, pas commencés

- **Comptes utilisateurs** : décidé le 12/09/2026 — vrais comptes complets, via Supabase Auth
  (pas Clerk, déjà intégré à la même base). Gros morceau : réécrire toute la logique
  `localStorage` de `index.html` (notation, profil de goûts, bangers) pour qu'elle parle à
  Supabase. Reporté, pas de date.
- **Rendez-vous du vendredi sous-exploité** côté produit (pas de date affichée, pas de compte
  à rebours, pas d'archive des semaines passées) — identifié comme le plus gros gain
  disponible à faible coût, jamais attaqué.
- **La Piste** (cosine.club) cassée — backend externe mort, mis de côté.
- **Spotify** : recherche impossible tant que le compte propriétaire de l'app n'a pas
  Premium (limitation de l'API Spotify elle-même, pas de notre code).

## Suivi

Le suivi détaillé tâche par tâche continue de vivre dans la page Notion "TO DO LIST" (sous
MOLE) — ce fichier donne le contexte structurel, Notion donne l'historique fin.
