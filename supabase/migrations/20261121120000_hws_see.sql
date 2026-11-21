-- HWS SEE — interní 3D prohlížeč projektů (tools/hws-see/SPEC.md). A NEW, standalone module beside
-- ABF Generator / HWS Easy. PURELY ADDITIVE: only new `see_*` tables and functions; no existing
-- table, column, row, trigger or function is touched (set_updated_at() from init_schema is reused).
--
-- Data model:
--   see_projects            one project (název, popis, provozní stav active/paused/archived/deleted)
--   see_scenes              alternative 3D scenes of one project (max 3 GLB in the MVP), own settings
--   see_annotations         3D popisky, ALWAYS scene-specific, position in the scene's model space
--   see_files               metadata of every uploaded object (GLB / PDF / JPG / PNG); bytes live in
--                           Cloudflare R2 under an opaque key, never in Postgres
--   see_file_scene_links    which scenes a document belongs to (applies_to_all = "Všechny modely")
--   see_publications        exactly one per project; mode is ONLY 'public' or 'pin' (no password
--                           mode, no customer login, no whitelist); the published content is an
--                           immutable snapshot, drafts never leak into it
--   see_access_grants       short-lived grants created after a server-verified PIN; only a SHA-256
--                           hash of the grant token is stored
--   see_pin_attempts        failed PIN attempts for server-side rate limiting (hashed client key,
--                           never a raw IP)
--   see_events              privacy-friendly opens of a published presentation (daily-rotating
--                           visitor hash, never a raw IP)
--
-- NOT applied to any live Supabase project by this file alone — apply manually (`supabase db push`
-- or the SQL editor) only after explicit review, DEV first. Rollback: supabase/rollbacks/20261121120000_hws_see.down.sql (kept outside migrations/ so `supabase db push` never runs it).

create table see_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '',
  status text not null default 'active' check (status in ('active', 'paused', 'archived', 'deleted')),
  created_by text,
  created_by_label text,
  updated_by text,
  updated_by_label text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column see_projects.created_by is 'Identity from the portal session adapter (lib/see/auth.server.ts). With today''s shared portal login this is the honest placeholder "portal:shared", never an invented person.';

create index see_projects_status_updated_idx on see_projects (status, updated_at desc);

create trigger see_projects_set_updated_at before update on see_projects for each row execute function set_updated_at();

create table see_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references see_projects (id) on delete cascade,
  kind text not null check (kind in ('model', 'document')),
  display_name text not null,
  original_file_name text not null,
  mime_type text not null check (mime_type in ('model/gltf-binary', 'application/pdf', 'image/jpeg', 'image/png')),
  size_bytes bigint not null check (size_bytes > 0),
  storage_key text not null unique,
  status text not null default 'pending' check (status in ('pending', 'ready', 'rejected')),
  applies_to_all boolean not null default true,
  sort_order integer not null default 0,
  -- Models: server-side GLB inspection at upload (glTF extensions incl. KTX2/Draco/Meshopt, counts).
  model_info jsonb,
  created_by text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index see_files_project_idx on see_files (project_id);

create trigger see_files_set_updated_at before update on see_files for each row execute function set_updated_at();

create table see_scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references see_projects (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  sort_order integer not null default 0,
  model_file_id uuid references see_files (id) on delete set null,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column see_scenes.settings is 'SeeSceneSettings (domain/seeProject.ts): saved camera {position,target,fov}, background, lighting preset, exposure, default annotation visibility.';

create index see_scenes_project_idx on see_scenes (project_id, sort_order);

create trigger see_scenes_set_updated_at before update on see_scenes for each row execute function set_updated_at();

create table see_annotations (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references see_scenes (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  body text not null default '',
  position jsonb not null,
  normal jsonb,
  visible boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index see_annotations_scene_idx on see_annotations (scene_id, sort_order);

create trigger see_annotations_set_updated_at before update on see_annotations for each row execute function set_updated_at();

create table see_file_scene_links (
  file_id uuid not null references see_files (id) on delete cascade,
  scene_id uuid not null references see_scenes (id) on delete cascade,
  primary key (file_id, scene_id)
);

create table see_publications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references see_projects (id) on delete cascade,
  share_slug text not null unique check (char_length(share_slug) >= 24),
  -- EXACTLY TWO sharing modes. Adding a third one requires a deliberate product decision.
  mode text not null default 'public' check (mode in ('public', 'pin')),
  status text not null default 'draft' check (status in ('draft', 'published')),
  pin_hash text,
  pin_set_at timestamptz,
  -- Incremented on every security-relevant change (PIN change, mode change, unpublish, link
  -- rotation, pause/archive/delete). A grant is valid only for the epoch it was issued in.
  access_epoch integer not null default 1,
  snapshot jsonb,
  snapshot_revision integer not null default 0,
  view_count integer not null default 0,
  last_viewed_at timestamptz,
  -- Who may frame /see/embed/<slug>: global default policy, an explicit list of sites, or nobody.
  embed_policy text not null default 'default' check (embed_policy in ('default', 'allowlist', 'none')),
  embed_origins text[] not null default '{}' check (cardinality(embed_origins) <= 20),
  published_at timestamptz,
  published_by text,
  unpublished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint see_publications_pin_requires_hash check (mode <> 'pin' or pin_hash is not null)
);

comment on column see_publications.pin_hash is 'pbkdf2_sha256$iterations$salt$hash — the PIN itself is never stored, logged or returned after the moment it was set.';

create trigger see_publications_set_updated_at before update on see_publications for each row execute function set_updated_at();

create table see_access_grants (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references see_publications (id) on delete cascade,
  token_hash text not null unique,
  access_epoch integer not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index see_access_grants_publication_idx on see_access_grants (publication_id);

create table see_pin_attempts (
  id bigint generated always as identity primary key,
  publication_id uuid not null references see_publications (id) on delete cascade,
  client_hash text not null,
  created_at timestamptz not null default now()
);

create index see_pin_attempts_lookup_idx on see_pin_attempts (publication_id, created_at desc);

create table see_events (
  id bigint generated always as identity primary key,
  project_id uuid not null references see_projects (id) on delete cascade,
  publication_id uuid not null references see_publications (id) on delete cascade,
  kind text not null default 'view' check (kind in ('view')),
  visitor_hash text not null,
  embed boolean not null default false,
  created_at timestamptz not null default now()
);

create index see_events_dedupe_idx on see_events (publication_id, visitor_hash, created_at desc);

-- Atomic "count one real open": skips refreshes of the same (daily-rotating, hashed) visitor within
-- the dedupe window, otherwise inserts the event and increments the publication counter.
create or replace function see_record_view(
  p_publication_id uuid,
  p_project_id uuid,
  p_visitor_hash text,
  p_embed boolean,
  p_dedupe_seconds integer
) returns boolean
language plpgsql
as $$
begin
  if exists (
    select 1 from see_events
    where publication_id = p_publication_id
      and visitor_hash = p_visitor_hash
      and created_at > now() - make_interval(secs => p_dedupe_seconds)
  ) then
    return false;
  end if;
  insert into see_events (project_id, publication_id, kind, visitor_hash, embed)
    values (p_project_id, p_publication_id, 'view', p_visitor_hash, p_embed);
  update see_publications
    set view_count = view_count + 1, last_viewed_at = now()
    where id = p_publication_id;
  return true;
end;
$$;

-- Browser must never talk to Postgres directly — RLS with zero policies, same convention as every
-- other table; the server-only service-role client bypasses RLS by design.
alter table see_projects enable row level security;
alter table see_files enable row level security;
alter table see_scenes enable row level security;
alter table see_annotations enable row level security;
alter table see_file_scene_links enable row level security;
alter table see_publications enable row level security;
alter table see_access_grants enable row level security;
alter table see_pin_attempts enable row level security;
alter table see_events enable row level security;

revoke execute on function see_record_view(uuid, uuid, text, boolean, integer) from public, anon, authenticated;
