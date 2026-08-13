-- HomeworkStudio Booth Generator — initial Postgres schema (Supabase).
--
-- Scope: Projects and Events stay hybrid (indexed columns + a JSONB "document" holding
-- the full existing domain payload — ProjectRecord / Exhibition — unchanged). The catalog
-- import pipeline gets its own normalized tables. Cloudflare R2 remains the only object
-- storage: nothing here duplicates it, R2 storageKeys just travel inside the JSONB
-- documents exactly as the domain model already stores them.
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually
-- (e.g. `supabase db push` or the Supabase SQL editor) only after explicit review.

create extension if not exists pgcrypto;

-- Shared trigger: keeps updated_at correct even if a future direct SQL statement (outside
-- the app's repository layer, which also sets it defensively) forgets to touch it.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- =========================================================================
-- EVENTS — mirrors domain/organizations.ts Exhibition. `document` is the full
-- normalizeExhibition() payload (logo/cover/document StoredAsset + storageKey fields
-- included verbatim — presigned URLs are never persisted, only storageKeys are).
-- =========================================================================
create table events (
  id text primary key,
  source_key text not null unique,
  name text not null,
  year integer not null,
  active boolean not null default true,
  start_date date,
  end_date date,
  document jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column events.source_key is 'Stable Excel-import identity, e.g. "beauty" / "arch" — not necessarily the primary key. Unique per table (single source system today); scope to source_system too if a second import source is ever added.';
comment on column events.document is 'Full Exhibition domain object (normalizeExhibition output), including priceListIds/defaultPriceListId.';
comment on column events.revision is 'Optimistic concurrency counter — see domain SupabaseEventRepository.';

create trigger events_set_updated_at before update on events for each row execute function set_updated_at();

-- =========================================================================
-- PROJECTS — mirrors domain/project.ts ProjectRecord. Deliberately NOT normalized into
-- many tables in this first DB phase; the full ProjectRecord stays a versioned JSONB
-- payload and normalizeProjectRecord() still runs on every read, same as
-- LocalProjectRepository today.
-- =========================================================================
create table projects (
  id text primary key,
  schema_version integer not null,
  event_id text references events (id),
  company_name text,
  lifecycle_status text not null,
  document jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column projects.event_id is 'Maps to ProjectRecord.fairId; nullable because not every project references a fair.';
comment on column projects.lifecycle_status is 'Maps to ProjectRecord.status (draft/inProgress/ready/archived).';
comment on column projects.document is 'Full ProjectRecord domain object; normalizeProjectRecord() still runs on read.';

create trigger projects_set_updated_at before update on projects for each row execute function set_updated_at();

-- =========================================================================
-- CATALOG ITEMS — DB primary id is independent of the business internal_code (section 4:
-- internal_code = NULL is a valid, non-blocking state; only non-null codes must be unique).
-- =========================================================================
create table catalog_items (
  id uuid primary key default gen_random_uuid(),
  internal_code text,
  kind text not null,
  lifecycle_status text not null default 'needs_review',
  display_name text not null,
  official_name text,
  category text,
  unit text,
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_items_kind_check check (kind in ('booth','construction','furniture','technical_point','service','graphics_service','floor_finish','other')),
  constraint catalog_items_lifecycle_status_check check (lifecycle_status in ('draft','needs_review','active','inactive','archived'))
);

-- Postgres unique indexes ignore NULLs, so internal_code can repeat NULL across many
-- draft rows while any two non-null codes still collide — exactly section 4's contract.
create unique index catalog_items_internal_code_key on catalog_items (internal_code) where internal_code is not null;

comment on column catalog_items.document is 'Full ComponentDefinition or BoothType payload (the same shape data/components.ts / data/booths.ts already use). pricingUnit (bm/m²/piece/day/cubic-meter) lives here, not as its own column — it is never filtered/joined on, only displayed alongside the item.';

create trigger catalog_items_set_updated_at before update on catalog_items for each row execute function set_updated_at();

-- =========================================================================
-- PRICE LISTS / PRICING ENTRIES — event-specific overrides on top of catalog base prices.
-- Base prices (PRICELIST sheet) live as pricing_entries with price_list_id/event_id NULL;
-- event-specific prices (CZK/EUR sheets) get a row per event + currency.
--
-- PriceList mirrors the Project/Event hybrid: `document` is the full domain PriceList
-- object (source of truth, includes edition/validFrom/validTo/realizationCompanyId/active
-- already modeled in domain/organizations.ts) and the surrounding columns are indexed
-- copies of the fields we actually filter/join on — never a second competing source of
-- truth, same rule as section 12 for projects/events.
-- =========================================================================
create table price_lists (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  event_id text references events (id),
  currency text not null check (currency in ('CZK','EUR')),
  year integer not null,
  edition text,
  -- Soft reference only: no realization_companies table exists yet (current domain model
  -- — RealizationCompany — doesn't need normalizing until something depends on it), so
  -- this stays a plain id column rather than an FK — section 6 explicitly allows this.
  realization_company_id text,
  valid_from date,
  valid_to date,
  active boolean not null default true,
  document jsonb not null,
  created_at timestamptz not null default now()
);

comment on column price_lists.code is 'Deterministic, e.g. BEAUTY-2026-CZK — see buildImportPriceListCode() in domain/importBatch.ts.';
comment on column price_lists.document is 'Full domain PriceList object — source of truth. Columns above are indexed copies for filtering/joins only.';
comment on column price_lists.realization_company_id is 'Soft reference to RealizationCompany.id — no FK, no realization_companies table yet (section 6).';

-- Historical price lists must never be deleted (section 4) — the default RESTRICT
-- behavior of the pricing_entries FK below already prevents deleting a price list that
-- still has priced entries, so no extra trigger is needed to enforce this.

create table pricing_entries (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid references catalog_items (id),
  price_list_id uuid references price_lists (id),
  event_id text references events (id),
  -- Independent of price_list_id: the same price list can theoretically span realization
  -- contexts, and a realization-specific override can exist without a dedicated price
  -- list. Soft reference, same reasoning as price_lists.realization_company_id above.
  realization_company_id text,
  currency text not null check (currency in ('CZK','EUR')),
  sale_price numeric,
  purchase_price numeric,
  valid_from date,
  valid_to date,
  -- "fixed" salePrice is a real number | "individual" must be quoted per case (e.g.
  -- Kontejner), sale_price stays NULL | "included" already covered by a package (e.g. P86
  -- fascia graphics), sale_price is 0 and must not be charged again. See PricingEntryMode
  -- in domain/models.ts — section 2's fix against overloading 0 as "missing".
  price_mode text not null default 'fixed' check (price_mode in ('fixed','individual','included')),
  created_at timestamptz not null default now(),
  constraint pricing_entries_individual_has_no_sale_price check (price_mode <> 'individual' or sale_price is null),
  constraint pricing_entries_included_sale_price check (price_mode <> 'included' or sale_price is null or sale_price = 0)
);

comment on column pricing_entries.sale_price is 'NULL means "unknown"/"individual", never 0 as a substitute — mirrors domain/priceImport.ts ParsedPrice and domain/catalog.ts derivePricingAvailability semantics.';
comment on column pricing_entries.purchase_price is 'Internal only — never exposed in customer-facing exports; see domain pricing customer-safe rules.';

create index pricing_entries_catalog_item_id_idx on pricing_entries (catalog_item_id);
create index pricing_entries_price_list_id_idx on pricing_entries (price_list_id);
create index pricing_entries_event_id_idx on pricing_entries (event_id);
create index pricing_entries_realization_company_id_idx on pricing_entries (realization_company_id);

-- =========================================================================
-- IMPORT AUDIT TRAIL — every Excel upload is one ImportBatch; every relevant source row
-- becomes one ImportRow with full raw + normalized traceability (section 25).
-- =========================================================================
create table import_batches (
  id uuid primary key default gen_random_uuid(),
  source_file_name text not null,
  source_fingerprint text not null,
  source_version text,
  status text not null default 'dry_run' check (status in ('dry_run','applied','failed')),
  summary jsonb,
  created_at timestamptz not null default now()
);

create table import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches (id) on delete cascade,
  source_sheet text not null,
  source_row integer not null,
  source_key text,
  raw_name text not null,
  raw_category text,
  raw_values jsonb not null,
  normalized_values jsonb not null,
  mapping_status text not null,
  target_entity_id uuid references catalog_items (id),
  issues jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index import_rows_import_batch_id_idx on import_rows (import_batch_id);
create index import_rows_source_sheet_source_key_idx on import_rows (source_sheet, source_key);

-- =========================================================================
-- CATALOG MAPPINGS — persists a human's confirmed "Excel row X = catalog item Y" decision
-- so the next import of the same workbook recognizes it instead of asking again.
--
-- Section 7: normalized_name alone is NOT a safe uniqueness key — the same name can
-- legitimately appear in a different sheet or category as a genuinely different source
-- item. source_key folds in sheet + category (see buildMappingSourceKey() in
-- domain/importBatch.ts) and is what re-import lookups and this constraint key on;
-- normalized_name stays only for fuzzy search/display.
-- =========================================================================
create table catalog_mappings (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  source_key text not null,
  normalized_name text not null,
  catalog_item_id uuid not null references catalog_items (id),
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (source_system, source_key)
);

create index catalog_mappings_normalized_name_idx on catalog_mappings (normalized_name);

-- =========================================================================
-- Section 32: browser must never talk to Postgres directly. Enable RLS with zero
-- policies on every table — the anon/public API key then gets nothing, while the
-- server-only service-role client (SUPABASE_SECRET_KEY) bypasses RLS by design and keeps
-- working. No Supabase Auth yet, so no per-row policies are defined in this migration.
-- =========================================================================
alter table events enable row level security;
alter table projects enable row level security;
alter table catalog_items enable row level security;
alter table price_lists enable row level security;
alter table pricing_entries enable row level security;
alter table import_batches enable row level security;
alter table import_rows enable row level security;
alter table catalog_mappings enable row level security;
