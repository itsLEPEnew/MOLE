-- Catalogue MOLE — étape 2 de la refonte de la recherche (13/09/2026).
-- À lancer une fois dans le SQL Editor de Supabase.
--
-- Principe : au lieu d'interroger Deezer à chaque frappe, on interroge NOTRE base. Tout ce
-- qu'on découvre y est écrit définitivement (pas un cache qui expire), donc le catalogue
-- s'enrichit de ce que la communauté cherche réellement, et devient de plus en plus rapide.

-- recherche floue : permet "daft pun" -> "Daft Punk" sans indexation externe
create extension if not exists pg_trgm;

create table catalog_artists (
  id text primary key,                    -- "deezer-27" : même convention d'identifiants qu'ailleurs
  name text not null,
  name_norm text not null,                -- minuscules, sans accents : c'est ce qu'on interroge
  picture text,
  nb_fan bigint default 0,                -- notoriété -> sert au classement
  discography_synced_at timestamptz,      -- date de la dernière ingestion complète de sa discographie
  updated_at timestamptz default now()
);

create table catalog_albums (
  id text primary key,                    -- "deezer-109301"
  title text not null,
  title_norm text not null,
  artist_id text,
  artist_name text not null,
  artist_name_norm text not null,
  record_type text,                       -- album / ep / single, donné par Deezer (plus de suffixe deviné)
  release_date text,                      -- "2026-09-11"
  cover text,
  nb_tracks integer,
  -- la tracklist est stockée AVEC l'album : l'appel Deezer qui donne la date la contient déjà,
  -- on la jetait jusqu'ici pour la redemander à l'ouverture de la fiche ("chargement en cours")
  tracklist jsonb default '[]',
  rank bigint default 0,
  updated_at timestamptz default now()
);

-- index trigram : c'est eux qui rendent le ILIKE '%...%' rapide malgré le joker en tête
create index catalog_artists_name_trgm on catalog_artists using gin (name_norm gin_trgm_ops);
create index catalog_albums_title_trgm on catalog_albums using gin (title_norm gin_trgm_ops);
create index catalog_albums_artist_trgm on catalog_albums using gin (artist_name_norm gin_trgm_ops);

-- classement et fraîcheur
create index catalog_artists_fans on catalog_artists (nb_fan desc);
create index catalog_albums_release on catalog_albums (release_date desc);
create index catalog_albums_artist on catalog_albums (artist_id);

-- Même posture que les 3 tables existantes : RLS activé sans aucune règle. Seule la clé
-- secrète (côté serveur, jamais exposée au navigateur) lit et écrit.
alter table catalog_artists enable row level security;
alter table catalog_albums enable row level security;
