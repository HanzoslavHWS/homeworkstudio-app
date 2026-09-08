-- Technické rastry — a NEW, standalone module (spec: "Nejde o generátor stánku ani o generátor
-- tiskových ploch"). Same hybrid pattern as print_surface_projects (20260906150000_print_surfaces.sql)
-- and the main `projects` table: indexed columns for what the project list actually queries/filters
-- on, everything else (raster layers/settings/detected stand labels, technical imports, the merged
-- stand buffer) in a `document` jsonb column — never a second competing source of truth for the
-- same fields, never a new parallel "projects" concept.
--
-- The source raster PDF and every technical-report PDF travel as StoredAsset references
-- (storageKey) inside `document` — never base64, never inlined into a DB column (spec section 31).
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually
-- (e.g. `supabase db push` or the Supabase SQL editor) only after explicit review.

create table technical_raster_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  event_id text references events (id),
  hall text,
  created_by text,
  document jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column technical_raster_projects.created_by is 'Reserved for a future real per-user login — always NULL today, same convention as print_surface_projects.created_by / email_history.user_id.';
comment on column technical_raster_projects.document is 'sourceRasterAsset (StoredAsset reference to the authoritative, never-modified raster PDF), rasterLayers[]/rasterSettings (detected PDF Optional Content Groups + per-project visibility/work-mode preferences), rasterStandLabels[] (stand-number text occurrences detected in the raster''s own text layer), imports[] (one row per uploaded technical-service PDF, kept forever even once superseded — spec section 24), and stands[] (the merged per-stand buffer: services[]/notes[]/placement, keyed by normalizedStandNumber — spec section 15/27). See domain/technicalRaster.ts for the full shape.';

create index technical_raster_projects_event_id_idx on technical_raster_projects (event_id);

create trigger technical_raster_projects_set_updated_at before update on technical_raster_projects for each row execute function set_updated_at();

-- Browser must never talk to Postgres directly — enable RLS with zero policies (same convention as
-- init_schema.sql section 32 / print_surfaces migration); the server-only service-role client
-- bypasses RLS by design.
alter table technical_raster_projects enable row level security;
