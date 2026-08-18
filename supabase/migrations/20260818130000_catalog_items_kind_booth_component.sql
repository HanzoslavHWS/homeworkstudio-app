-- Widens catalog_items_kind_check to allow 'booth_component' (domain/models.ts's CatalogItemKind
-- already includes it — this migration only catches the DB up). No other schema change:
-- internal_code stays optional+unique-if-present, lifecycle_status/document shape are unchanged.
-- See domain/catalogReadiness.ts's booth_component readiness case (GLB + SKP required, no
-- dimensions rule) for why no new columns are needed.
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually
-- (e.g. `supabase db push` or the Supabase SQL editor) only after explicit review, same as
-- 20260813120000_init_schema.sql and 20260814180000_pricing_entries_audit_columns.sql.

alter table catalog_items drop constraint catalog_items_kind_check;
alter table catalog_items add constraint catalog_items_kind_check
  check (kind in ('booth','booth_component','construction','furniture','technical_point','service','graphics_service','floor_finish','other'));
