-- Zákaznický katalog ("Katalog") — saved export configurations, e.g. "FOR BEAUTY 2026 – kompletní
-- katalog". PURELY ADDITIVE: one new table, no existing table/column/row is touched.
--
-- This is NOT a second catalog and holds no prices. `config` only remembers a selection: the event
-- / price list / currency context, the type + category filter, the chosen catalog_items ids, the
-- shown-fields switches and the category order (see CustomerCatalogPresetConfig in
-- domain/customerCatalog.ts). Items and prices are always read live from catalog_items /
-- pricing_entries when a configuration is opened. Item ids are therefore deliberately soft
-- references inside jsonb (no FK): an item archived or unpublished later simply no longer appears.
--
-- The per-item publication metadata ("Publikace v katalogu": visible / catalog name / short
-- description / image / sort order) needs NO migration — it lives in the existing
-- catalog_items.document jsonb as `catalogPublication` (domain/catalogItemsAdmin.ts).
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually
-- (e.g. `supabase db push` or the Supabase SQL editor) only after explicit review. Until then the
-- Katalog module works fully; only saving/loading configurations is unavailable.

create table customer_catalog_presets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger customer_catalog_presets_set_updated_at before update on customer_catalog_presets for each row execute function set_updated_at();

-- Browser must never talk to Postgres directly — RLS with zero policies, same convention as every
-- other table; the server-only service-role client bypasses RLS by design.
alter table customer_catalog_presets enable row level security;
