-- Adds the 4 confirmed real Graphics Pricing rates for BEAUTY-2026-CZK / BEAUTY-2026-EUR:
--   GRAPHICS-FASCIA    (Grafika – límec)      450 CZK/bm  |  20 EUR/bm
--   GRAPHICS-FULL-WRAP (Grafika – celopolep) 1000 CZK/m²  |  43 EUR/m²
--
-- Depends on 20260825120000_graphics_service_catalog_items.sql having already created the two
-- catalog_items rows — looked up here by internal_code (GRAPHICS-FASCIA / GRAPHICS-FULL-WRAP)
-- via a JOIN, never by a literal id: catalog_items.id is a DB-generated UUID, never equal to
-- the static TypeScript fallback ids ("service-graphics-fascia"/"service-graphics-full-wrap")
-- domain/technicalServices.ts's TECHNICAL_SERVICE_IDS still carries for the legacy seed path
-- (see findCatalogItemByIdentity, domain/catalog.ts). If that catalog migration has not been
-- applied yet, the JOIN below simply matches nothing and this migration inserts 0 rows — it
-- never errors, but also never silently invents a catalog_item_id.
--
-- price_list_id is resolved the same way, by price_lists.code (BEAUTY-2026-CZK/-EUR) — never
-- a hardcoded UUID, so this migration stays correct even if those price lists are ever
-- recreated with different ids.
--
-- Idempotent: pricing_entries has no unique constraint (init_schema.sql only indexes it), so
-- this mirrors domain/importBatch2a.ts's existing pricing dedup business key — exactly
-- (catalog_item_id, price_list_id, event_id, currency), the same key
-- resolveImportPriceUpdate()/its "existing" lookup already use for every other pricing import
-- in this project — via a NOT EXISTS guard on the INSERT ... SELECT. Re-running this file is a
-- no-op once the 4 rows exist.
--
-- realization_company_id stays NULL (section 5): these are generic PriceList rates, not yet
-- scoped to a particular realization company. An exact-realization-company override can be
-- added later as its own row — selectPricingEntry() (domain/catalog.ts) already prioritizes an
-- exact match over a generic (NULL) entry, no code change needed for that later addition.
--
-- source = 'manual' / source_price = NULL (20260814180000_pricing_entries_audit_columns.sql):
-- these 4 rates are confirmed business numbers entered directly here, not the output of an
-- Excel import batch — so there is no "source_price" import reference to record, and a future
-- import must never silently overwrite them (same protection Pricing Administration edits get).
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually
-- (e.g. `supabase db push` or the Supabase SQL editor) only after explicit review, same as
-- every other migration in this folder.

insert into pricing_entries (catalog_item_id, price_list_id, event_id, realization_company_id, currency, sale_price, price_mode, source)
select ci.id, pl.id, pl.event_id, null, pl.currency, rates.sale_price, 'fixed', 'manual'
from (
  values
    ('GRAPHICS-FASCIA', 'BEAUTY-2026-CZK', 450::numeric),
    ('GRAPHICS-FULL-WRAP', 'BEAUTY-2026-CZK', 1000::numeric),
    ('GRAPHICS-FASCIA', 'BEAUTY-2026-EUR', 20::numeric),
    ('GRAPHICS-FULL-WRAP', 'BEAUTY-2026-EUR', 43::numeric)
) as rates (internal_code, price_list_code, sale_price)
join catalog_items ci on ci.internal_code = rates.internal_code
join price_lists pl on pl.code = rates.price_list_code
where not exists (
  select 1 from pricing_entries pe
  where pe.catalog_item_id = ci.id
    and pe.price_list_id = pl.id
    and pe.event_id is not distinct from pl.event_id
    and pe.currency = pl.currency
);
