-- Graphics Pricing foundation fix: adds the two catalog_items rows backing
-- domain/technicalServices.ts's TECHNICAL_SERVICE_IDS.fasciaGraphics / fullWrapGraphics.
--
-- The 2026-08-20 live-DB audit confirmed GRAPHICS-FULL-WRAP and GRAPHICS-FASCIA did not
-- exist in catalog_items at all, so priceGraphics/resolveGraphicsSurfacePricing could
-- never resolve a DB-backed rate — every project fell through to needs-quote
-- unconditionally. This migration only creates the catalog identities; see
-- domain/technicalServices.ts's findCatalogItemByIdentity (internalCode-first, legacy
-- static id fallback) for the matching lookup-side fix landed in the same batch.
--
-- Idempotent: keyed uniquely by internal_code via the existing partial unique index
-- catalog_items_internal_code_key (init_schema.sql, ignores NULLs) — ON CONFLICT (internal_code)
-- WHERE internal_code IS NOT NULL DO NOTHING makes this safe to re-run and safe against a row
-- already having been created some other way (e.g. manually in the admin UI) before this
-- migration runs. The WHERE clause is required, not decorative: Postgres can only infer a
-- partial unique index as the ON CONFLICT target when the same predicate is repeated on the
-- INSERT statement — omitting it fails with "no unique or exclusion constraint matching the ON
-- CONFLICT specification" (SQLSTATE 42P10), caught when first applying this migration.
--
-- Deliberately NO pricing_entries here and NO sale_price anywhere in this file: real
-- sale rates are not yet known and must never be guessed (same rule the 2026-08-20 audit
-- was written to enforce). Until real pricing_entries rows are added per price list,
-- both items keep resolving to needs-quote ("Cena není nastavena"), exactly like any
-- other technical service without a configured rate.
--
-- document mirrors data/components.ts's fasciaGraphicsService/fullWrapGraphicsService
-- ComponentDefinition seed field-for-field (the current document contract for these two
-- items), plus lifecycleStatus/catalogItemKind — the two fields every DB-backed
-- technical-service document also carries (see domain/importBatch2a.ts's
-- stubTechnicalServiceItem) but the frontend-only static seed predates and omits.
-- document.id is a synthetic placeholder string, not the real catalog_items.id primary
-- key (which Postgres generates on insert) — this mirrors stubTechnicalServiceItem's own
-- id convention and is safe because nothing ever reads document.id back: the runtime
-- path (domain/catalogPricing.ts's toTechnicalServiceComponentDefinition) always
-- rebuilds ComponentDefinition.id from the catalog_items.id column, never from document.
--
-- kind = 'service' (not 'graphics_service', even though catalog_items_kind_check
-- already allows it since 20260818130000) to match every other live technical-service
-- catalog item, all of which use kind = 'service' — see the 2026-08-20 audit's kind
-- breakdown (service: 23, no graphics_service rows exist in practice).
--
-- NOT applied to any live Supabase project by this migration file alone — apply
-- manually (e.g. `supabase db push` or the Supabase SQL editor) only after explicit
-- review, same as every other migration in this folder.

insert into catalog_items (internal_code, kind, lifecycle_status, display_name, category, unit, document)
values
  (
    'GRAPHICS-FASCIA',
    'service',
    'needs_review',
    'Grafika – límec',
    'services',
    'bm',
    jsonb_build_object(
      'id', 'catalog-item-graphics-fascia',
      'internalCode', 'GRAPHICS-FASCIA',
      'displayName', 'Grafika – límec',
      'type', 'service-graphics',
      'name', 'Grafika – límec',
      'category', 'services',
      'sceneLabel', 'Grafika – límec',
      'widthMm', 0,
      'depthMm', 0,
      'resizable', false,
      'productionProfiles', '{}'::jsonb,
      'rotation', jsonb_build_object(
        'defaultMode', 'snap',
        'snapStep', 90,
        'quickAngles', jsonb_build_array(0),
        'allowFreeRotation', false,
        'locked', true
      ),
      'systemLocked', true,
      'userLocked', false,
      'visible', false,
      'showIn2D', false,
      'showIn3D', false,
      'sceneLayer', 'annotations',
      'printable', false,
      'unit', 'bm',
      'active', true,
      'catalogItemType', 'service',
      'pricingUnit', 'linear-meter',
      'vatRatePercent', 21,
      'pricingEntries', '[]'::jsonb,
      'lifecycleStatus', 'needs_review',
      'catalogItemKind', 'service'
    )
  ),
  (
    'GRAPHICS-FULL-WRAP',
    'service',
    'needs_review',
    'Grafika – celopolep',
    'services',
    'm²',
    jsonb_build_object(
      'id', 'catalog-item-graphics-full-wrap',
      'internalCode', 'GRAPHICS-FULL-WRAP',
      'displayName', 'Grafika – celopolep',
      'type', 'service-graphics',
      'name', 'Grafika – celopolep',
      'category', 'services',
      'sceneLabel', 'Grafika – celopolep',
      'widthMm', 0,
      'depthMm', 0,
      'resizable', false,
      'productionProfiles', '{}'::jsonb,
      'rotation', jsonb_build_object(
        'defaultMode', 'snap',
        'snapStep', 90,
        'quickAngles', jsonb_build_array(0),
        'allowFreeRotation', false,
        'locked', true
      ),
      'systemLocked', true,
      'userLocked', false,
      'visible', false,
      'showIn2D', false,
      'showIn3D', false,
      'sceneLayer', 'annotations',
      'printable', false,
      'unit', 'm²',
      'active', true,
      'catalogItemType', 'service',
      'pricingUnit', 'square-meter',
      'vatRatePercent', 21,
      'pricingEntries', '[]'::jsonb,
      'lifecycleStatus', 'needs_review',
      'catalogItemKind', 'service'
    )
  )
on conflict (internal_code) where internal_code is not null do nothing;
