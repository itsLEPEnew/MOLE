# MOLE — Le Tunnel — Brief de reprise

Colle ce message tel quel en premier message d'une nouvelle conversation Claude (mode Chat) pour reprendre le projet sans tout réexpliquer.

## Concept
MOLE (ex-"Iceberg") est un site/app (PWA) de recommandations musicales pour diggers. Le principe : ouvrir le site, recevoir une reco qui soit un vrai "banger", dans n'importe quel genre, avec un système qui permet de descendre du grand public vers l'ultra niche.

**Pivot d'univers validé** : la métaphore iceberg (jugée trop banale) est remplacée par une taupe qui creuse des tunnels/galeries. Le nom du repo (MOLE) colle parfaitement. Mascotte = logo fixe (pas un avatar évolutif). L'entrée du Tunnel est visuellement une niche de chien (jeu de mot sur "son niche").

## Direction artistique (validée)
Noir et blanc, dessiné à la main, esprit zine/fanzine punk, "home made" — traits d'encre irréguliers plutôt que du lisse/algorithmique. Fonds spécialisés par niveau de profondeur (texture/teinte qui évolue de la surface à la roche mère). Implémenté en v0.2 : palette monochrome papier/encre, dégradé de gris par palier, mascotte taupe et niche de chien en SVG. Question encore ouverte : noir et blanc strict (façon gravure) vs nuances de gris tolérées — v0.2 a choisi les nuances de gris par défaut, facilement ajustable.

## Structure du site (validée)
3 pages : **Recos de la taupe** (ex-Reco instantanée), **Le Tunnel** (ex-Explorer l'iceberg), **Actus** (contenu pas encore tranché — actu musicale générale ou actu de l'app, page en placeholder pour l'instant). Onglet **Mon Profil** en plus pour les réglages.

## Le Tunnel — mécaniques (validées et implémentées en v0.2)
- Barre de profondeur latérale toujours visible, avec un marqueur cliquable par palier.
- **Accès libre à tout palier, sans mérite à gagner** : on peut cliquer direct sur n'importe quel palier (même verrouillé), ça déclenche une traversée animée rapide (~70ms par palier intermédiaire) des paliers du dessus, jamais pénalisante, puis arrivée directe au palier visé.
- La descente palier par palier via un bouton "Creuser un peu plus" reste l'expérience par défaut pour qui veut le rythme du creusage.
- Question encore ouverte : barre de profondeur unique/globale vs une jauge par genre — v0.2 utilise une jauge par genre (mémorisée via le profil), à challenger si besoin.
- Vue "carte multi-tunnels" (comparer la progression sur tous les genres d'un coup) : proposée, pas encore implémentée.

## Algorithme de recommandation (principes validés, implémentés en v0.2)
- **"Banger"** : jamais basé sur la popularité/streams — uniquement sur une reconnaissance dans le milieu (samplé, cité en sets, jugé essentiel par les connaisseurs). Curation humaine, pas de scraping automatique de plateformes de streaming.
- **"Niche"** : toujours relatif au profil de l'utilisateur, jamais absolu. Le moteur cale le palier suggéré juste après ce que l'utilisateur connaît déjà (via le quiz Mon Profil).
- **Distribution des paliers jamais dominée par le mainstream** : biais implémenté 10% surface / 15% galeries / 25% cœur / 25% profond / 25% roche mère par défaut (avant personnalisation), jamais neutre à 50/50.
- **Curiosity Bar** : curseur permanent dans Mon Profil, joue uniquement sur le style (rester dans ses genres aimés vs explorer d'autres genres) — ne touche jamais à la profondeur. Remplace l'ancien ratio 70/30 codé en dur.
- **Feedback qualitatif par tags** (genre proche / ambiance / époque / "connaissais déjà") : proposé, pas encore implémenté — évolution prévue du système de like/dislike actuel.

## Sources de données envisagées pour la suite (recherche faite, rien codé encore)
- **Wikidata** (CC0) : généalogie des genres — "sous-genre de", "influencé par" — pour la structure du Tunnel.
- **MusicBrainz** (CC0 pour les données core) : relations factuelles vérifiables entre artistes (collaboration, a été professeur de, a fondé...). Contient des liens vers les pages Discogs correspondantes.
- **Discogs** : dumps mensuels en CC0 utilisables librement ; l'API live (marketplace, rareté/stock) est restreinte, usage commercial interdit — ne pas s'appuyer sur la rareté marketplace comme indicateur de niche si monétisation prévue.
- **Musicmap.info et Everynoise.com** : sources d'inspiration uniquement, PAS des données à réutiliser. Musicmap est protégé par copyright (classification et visuels) — contact prévu avec le créateur (Kwinten Crauwels) avant toute réutilisation, même partielle. Everynoise est gelé depuis fin 2023 et basé sur une taxonomie propriétaire Spotify.

## Contexte technique déjà décidé
- Site web (PWA installable via "Ajouter à l'écran d'accueil"), pas d'app mobile native pour l'instant — envisagée plus tard une fois un Mac/Xcode disponible.
- Pas de connexion Apple Music officielle : MusicKit nécessite un compte Apple Developer payant (99$/an, coût unique côté porteur du projet, évité tant que le concept n'est pas validé).
- Last.fm gratuit mais bloqué par CORS pour un appel direct navigateur — proxy Cloudflare Worker déjà écrit (`lastfm-proxy-worker.js`), pas encore déployé/branché.
- En attendant, profil de goût via quiz manuel (genres aimés + artistes déjà connus par palier), + Curiosity Bar pour le style.
- Déployé sur GitHub : repo `itsLEPEnew/MOLE`, hébergé via GitHub Pages.
- 5 genres curés à la main : Techno, House, Hip-Hop, Jazz, UK Bass/Jungle/Garage/Dubstep — 5 paliers chacun, ~100 recos réelles.

## Questions ouvertes (à trancher)
1. Barre de profondeur unique/globale ou une jauge par genre (v0.2 a choisi par genre, à confirmer ou changer).
2. Palette noir et blanc strict ou nuances de gris (v0.2 a choisi nuances de gris, à confirmer ou changer).
3. Contenu de la page Actus (actu musicale générale ou actu de l'app).
4. Vivier de la page "Recos de la taupe" : même pool que Le Tunnel, ou un pool "coup de cœur du jour" distinct.
5. Structure exacte des tags de feedback qualitatif (genre proche / ambiance / époque / connaissais déjà).
6. Noms définitifs des boutons/actions dans le vocabulaire Tunnel (proposés à titre d'exemple seulement).

## Prochaines étapes suggérées
- Trancher les questions ouvertes ci-dessus, au moins celles qui bloquent un choix technique.
- Contacter Kwinten Crauwels (Musicmap) pour clarifier ce qui est réutilisable.
- Intégrer techniquement le stack de données (Wikidata + MusicBrainz + dumps Discogs) pour la généalogie des genres.
- Vue "carte multi-tunnels" une fois plusieurs genres disponibles.
- Système de feedback qualitatif par tags (au lieu du simple quiz initial).
- En parallèle, pas prioritaire : extension à d'autres genres, déploiement du proxy Last.fm, export officiel Apple Music (privacy.apple.com).
