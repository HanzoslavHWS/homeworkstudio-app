-- Tiskové plochy V2 — moves the module from localStorage-only to the database (section 1).
--
-- Catalog (realization companies / presets / production dimensions) is fully relational — small,
-- flat records with real filter/join needs (mirrors email_history's fully-columned style, not the
-- projects/events hybrid-document style). Projects follow the SAME hybrid pattern as `projects`
-- (indexed columns for what the list/filters actually query + a `document` jsonb holding the full
-- domain payload — image reference + items[] — exactly section 12's rule: never a second
-- competing source of truth). Cloudflare R2 remains the only object storage — the uploaded booth
-- photo travels as a StoredAsset (storageKey) inside `document`, never a base64 blob in a row
-- (section 4) and never a new assets table (this schema's established convention — see init
-- schema's own header comment).
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually
-- (e.g. `supabase db push` or the Supabase SQL editor) only after explicit review.

-- =========================================================================
-- CATALOG — imported wholesale from the realizačka Excel (domain/printSurfaceExcelImport.ts).
-- =========================================================================

create table print_surface_realization_companies (
  id text primary key,
  name text not null,
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column print_surface_realization_companies.id is 'Deterministic slug of the Excel-header company name (see slugifyCompanyName in domain/printSurfaceExcelImport.ts) — never depends on row/column order.';

create trigger print_surface_realization_companies_set_updated_at before update on print_surface_realization_companies for each row execute function set_updated_at();

create table print_surface_presets (
  id text primary key,
  type_id text not null,
  name text not null,
  description text,
  is_active boolean not null default true,
  parent_id text,
  parent_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column print_surface_presets.id is 'The Excel "interni id" column, used as-is — never the row index (spec section 8/3).';
comment on column print_surface_presets.parent_id is 'Soft reference only (no FK): the id of the grouping "product" Excel row (e.g. a pult/vitrína) this preset''s Čelo/Bok belongs to. That group row is NEVER itself inserted into this table (see domain/printSurfaceExcelImport.ts''s isGroupRow — a parent/group row never becomes its own preset), so it has nothing to reference here; NULL for a standalone preset (panels) too.';
comment on column print_surface_presets.parent_name is 'Denormalized copy of the parent row''s name, purely for display (see printSurfacePresetDisplayName) — kept alongside parent_id rather than joined every read.';

create index print_surface_presets_parent_id_idx on print_surface_presets (parent_id);

create trigger print_surface_presets_set_updated_at before update on print_surface_presets for each row execute function set_updated_at();

create table print_surface_production_dimensions (
  id uuid primary key default gen_random_uuid(),
  realization_company_id text not null references print_surface_realization_companies (id) on delete cascade,
  preset_id text not null references print_surface_presets (id) on delete cascade,
  status text not null check (status in ('available','unavailable')),
  width_mm integer,
  height_mm integer,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (realization_company_id, preset_id),
  constraint print_surface_production_dimensions_available_has_size check (status <> 'available' or (width_mm is not null and height_mm is not null)),
  constraint print_surface_production_dimensions_unavailable_has_no_size check (status <> 'unavailable' or (width_mm is null and height_mm is null))
);

comment on column print_surface_production_dimensions.status is 'available = real width_mm/height_mm known; unavailable = the Excel explicitly said NO/NO ("tato realizačka tuto plochu nemá v nabídce") — NEVER width_mm=0/height_mm=0. A missing row entirely (no combination at all) means NOT_DEFINED — see resolvePrintSurfaceProductionDimension in domain/printSurfaceProductionDimension.ts, the only place this is resolved.';

create index print_surface_production_dimensions_preset_id_idx on print_surface_production_dimensions (preset_id);

create trigger print_surface_production_dimensions_set_updated_at before update on print_surface_production_dimensions for each row execute function set_updated_at();

-- =========================================================================
-- PROJECTS — mirrors the `projects` table's hybrid pattern (section 1: "nevytvářej paralelní DB
-- systém"). `document` holds PrintSurfaceProject's `views[]` (up to MAX_PRINT_SURFACE_VIEWS
-- uploaded images, each a StoredAsset reference + pixel dimensions + a user-renamable label —
-- never base64), `items[]` (the PHYSICAL print surfaces — what gets priced, position-less) and
-- `placements[]` (one pin of an item on one view, via itemId+imageId — a surface pinned on two
-- views is still one item, priced once) — everything NOT already indexed below. No optimistic-
-- concurrency `revision` column (unlike `projects`) — this is a single-editor-at-a-time workflow
-- (autosave from one open tab), not multi-tab collaborative editing; a deliberate scope reduction,
-- not an oversight.
-- =========================================================================
create table print_surface_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company_name text not null default '',
  event_id text references events (id),
  realization_company_id text references print_surface_realization_companies (id),
  status text not null default 'draft' check (status in ('draft','ready','sent')),
  created_by text,
  sent_at timestamptz,
  sent_by text,
  document jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint print_surface_projects_sent_pair check ((sent_at is null) = (sent_by is null))
);

comment on column print_surface_projects.created_by is 'Reserved for a future real per-user login — always NULL today, same convention as email_history.user_id (no users table exists yet).';
comment on column print_surface_projects.sent_at is 'Only ever set by an explicit "mark as sent" action — never just because an Outlook draft or PDF preview was opened (spec section 14). Always paired with sent_by.';
comment on column print_surface_projects.document is 'PrintSurfaceProject''s views[] (up to 2 uploaded images, StoredAsset references, never base64) + items[] (physical print surfaces — priceable, position-less) + placements[] (pins linking an item to a view+x/y) — the columns above are indexed copies of what the project list/filters actually query, never a second source of truth for the same fields. An older document may still hold a single legacy `image` field, or items with embedded position/imageId instead of separate placements[] — see migrateLegacyPrintSurfaceDocument in domain/printSurfaceProject.ts, applied on every read.';

create index print_surface_projects_event_id_idx on print_surface_projects (event_id);
create index print_surface_projects_realization_company_id_idx on print_surface_projects (realization_company_id);
create index print_surface_projects_status_idx on print_surface_projects (status);

create trigger print_surface_projects_set_updated_at before update on print_surface_projects for each row execute function set_updated_at();

-- =========================================================================
-- EXPORT HISTORY — section 15: never just a single export/sent boolean. One row per export
-- action; sent_at/sent_by/recipient/language/file_storage_key are reserved for when a real
-- send/PDF-file flow exists (this phase only builds the view-model + a "PDF / Tiskový přehled"
-- UI entry — see domain/printSurfaceExport.ts).
-- =========================================================================
create table print_surface_exports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references print_surface_projects (id) on delete cascade,
  export_type text not null check (export_type in ('pdf_overview')),
  created_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_by text,
  recipient text,
  language text,
  file_storage_key text
);

comment on column print_surface_exports.created_by is 'Reserved — always NULL today, same convention as print_surface_projects.created_by.';

create index print_surface_exports_project_id_idx on print_surface_exports (project_id);

-- =========================================================================
-- Browser must never talk to Postgres directly — enable RLS with zero policies on every table
-- (same convention as init_schema.sql section 32); the server-only service-role client bypasses
-- RLS by design.
-- =========================================================================
alter table print_surface_realization_companies enable row level security;
alter table print_surface_presets enable row level security;
alter table print_surface_production_dimensions enable row level security;
alter table print_surface_projects enable row level security;
alter table print_surface_exports enable row level security;
