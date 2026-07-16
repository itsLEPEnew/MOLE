# Iceberg — Music Digger — Brief de reprise

Colle ce message tel quel en premier message d'une nouvelle conversation Claude (mode Chat) pour reprendre le projet sans tout réexpliquer.

## Contexte
Je développe "Iceberg", un site/app de recommandations musicales pour diggers. Le principe : ouvrir le site, avoir une reco, que ce soit un banger — que ce soit dans n'importe quel genre. Fonctionnement en "iceberg" : de la surface (classiques grand public) jusqu'au fond abyssal (artistes ultra niche que quasi personne ne connaît), en passant par les pionniers de chaque genre/sous-genre. Objectif : se faire une culture musicale complète ou continuer à digger sans perdre de temps à chercher.

## Décisions prises
- On commence par un site web (PWA installable via "Ajouter à l'écran d'accueil"), pas une app mobile native pour l'instant — on y passera plus tard si la version web convainc, une fois qu'on aura un Mac/Xcode.
- Pas de connexion Apple Music officielle pour l'instant : MusicKit (l'API d'Apple) nécessite un compte Apple Developer payant (99$/an, payé une fois par le porteur du projet, pas par chaque utilisateur — mais on évite ce coût tant qu'on valide le concept).
- Last.fm est gratuit et pourrait donner un vrai profil d'écoute, mais son API bloque les appels directs depuis un navigateur (CORS) — il faudra un petit proxy serveur gratuit (Cloudflare Worker, script déjà écrit : `lastfm-proxy-worker.js` dans le repo) quand on voudra le brancher.
- En attendant une vraie connexion Apple Music/Last.fm, le profil de goût se construit via un quiz manuel dans l'app : genres aimés + artistes déjà connus par palier.

## Ce qui est déjà construit
- Prototype PWA complet et déployé : 5 genres curés à la main (Techno, House, Hip-Hop, Jazz, UK Bass/Jungle/Garage/Dubstep), 5 paliers "iceberg" par genre (surface → sous la surface → pionniers → profondeurs → fond abyssal), environ 100 recos réelles avec artiste/morceau/année/pourquoi ça compte.
- Deux modes : "Reco instantanée" (bouton qui tire une reco pondérée) et "Explorer l'iceberg" (on descend palier par palier dans un genre choisi).
- Un onglet "Mon profil" : tu coches les genres que t'aimes et les artistes que tu connais déjà par palier ; le moteur de reco biaise ensuite 70% vers tes genres aimés et cible le palier juste après ce que tu connais.
- Liens externes vers Apple Music (recherche) et YouTube sur chaque reco pour écouter.
- Déployé sur GitHub : repo `itsLEPEnew/MOLE`, hébergé via GitHub Pages.

## Prochaines étapes envisagées
- Étendre la base de données à d'autres genres (soul/funk, reggae/dub, post-punk, ambient, etc.).
- Déployer le proxy Last.fm pour avoir un vrai profil d'écoute au lieu du quiz manuel.
- Explorer l'export officiel Apple Music (privacy.apple.com, gratuit) comme autre source de profil.
- Si la version web convainc : passer à une app mobile native (nécessite un Mac + Xcode qu'on n'a pas encore).
