-- Adds manual/import provenance tracking to pricing_entries so a future Excel re-import can
-- tell a manually-overridden price apart from an untouched import price and never silently
-- clobber it. See domain/pricingAdmin.ts's resolveImportPriceUpdate() for the resolution
-- rules a future importer must apply using these columns (not implemented yet — this
-- migration and the reusable domain function are the safe groundwork for it).
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually
-- (e.g. `supabase db push` or the Supabase SQL editor) only after explicit review, same as
-- 20260813120000_init_schema.sql. This session only prepares + dry-runs it; APPLY is a
-- separate, explicit, later step.

alter table pricing_entries
  add column updated_at timestamptz not null default now(),
  add column source text not null default 'import' check (source in ('import', 'manual')),
  add column source_price numeric;

comment on column pricing_entries.updated_at is 'Maintained by the set_updated_at() trigger below (same convention as events/projects/catalog_items) — always reflects the last write to this row, whether from an import batch or a manual Pricing Administration edit.';
comment on column pricing_entries.source is E'Provenance of the CURRENT sale_price.\n''import'' = last written by an Excel import batch — a future import may safely overwrite it if the source price changed.\n''manual'' = last written by a human via Pricing Administration — a future import must NEVER silently overwrite this; see domain/pricingAdmin.ts resolveImportPriceUpdate() for the required conflict/review behavior.';
comment on column pricing_entries.source_price is 'The last price seen from an Excel import for this entry — NULL if this entry was created manually with no known import reference, or its price_mode carries no numeric price (individual). Only an import writes this column; a manual edit (Pricing Administration save) never touches it, so it always answers "what did the source file last say", independent of sale_price ("what does the app currently charge").';

create trigger pricing_entries_set_updated_at before update on pricing_entries for each row execute function set_updated_at();

-- Backfill: the 495 rows Batch #2A already wrote are, by definition, exactly what the Excel
-- import produced and have never been touched by Pricing Administration (which did not exist
-- yet when they were written) — so source='import' (already the column default) and
-- source_price mirrors the current sale_price exactly. This UPDATE only ever touches the
-- three new columns — sale_price/currency/price_mode/catalog_item_id/price_list_id/event_id
-- and every other existing column are never written here, and the WHERE clause makes this
-- statement safely re-runnable (a second run is a no-op, never a second overwrite).
update pricing_entries
set source = 'import',
    source_price = sale_price,
    updated_at = created_at
where source_price is null;
