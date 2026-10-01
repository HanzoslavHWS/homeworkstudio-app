-- Catalog revision foundation: catalog card types, separate ABF code, booth package contents,
-- and a hard-delete guard. PURELY ADDITIVE — no existing column, id, kind, lifecycle_status or
-- document is rewritten except for the two backfills below (item_type derived from kind,
-- abf_code copied from an ABF-shaped internal_code). No row is archived, deleted or re-keyed.
--
-- Pre-migration audit (live DB, 2026-10-01, read-only): 85 catalog_items, 4 active
-- (M57 židle, P86 kóje, L02 elektřina, "Sloupek 2500" booth_component). Saved projects
-- reference P86 by its legacy document id "koje-2x2" (ProjectRecord.boothId) and the STATIC
-- data/components.ts ids "chair-basic"/"technical-electrical" (sceneObjects[].definitionId) —
-- never a catalog_items UUID. technical_raster_projects / print_surface_* / tasks reference no
-- catalog_items id at all. pricing_entries / catalog_mappings / import_rows reference catalog
-- items by FK (already ON DELETE RESTRICT by default).
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually
-- (e.g. `supabase db push` or the Supabase SQL editor) only after explicit review, same as
-- every other migration in this folder. The app tolerates running BEFORE this migration is
-- applied (lib/db/catalogItemsAdmin.supabase.ts falls back to the legacy column set), but
-- abf_code/item_type/package edits and the KODY import need it.

-- =========================================================================
-- 1. item_type — the catalog CARD type (system property, 4 values). `kind` stays as the
--    finer-grained readiness/generator profile (domain/catalogReadiness.ts dispatches on it,
--    the generator pickers filter on it) — item_type never replaces it.
-- =========================================================================
alter table catalog_items add column item_type text;

update catalog_items
set item_type = case kind
  when 'booth' then 'BOOTH'
  when 'booth_component' then 'INTERNAL_COMPONENT'
  when 'service' then 'SERVICE'
  when 'graphics_service' then 'SERVICE'
  when 'technical_point' then 'SERVICE'
  else 'PRODUCT' -- furniture, floor_finish, construction, other
end
where item_type is null;

-- Older insert paths (scripts/importBatch*.ts, earlier SQL seeds) never send item_type — derive
-- it from kind with the SAME mapping as the backfill above (domain/catalogItemTypes.ts's
-- defaultItemTypeForKind) instead of failing the NOT NULL constraint.
create or replace function catalog_items_default_item_type() returns trigger as $$
begin
  if new.item_type is null then
    new.item_type := case new.kind
      when 'booth' then 'BOOTH'
      when 'booth_component' then 'INTERNAL_COMPONENT'
      when 'service' then 'SERVICE'
      when 'graphics_service' then 'SERVICE'
      when 'technical_point' then 'SERVICE'
      else 'PRODUCT'
    end;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger catalog_items_default_item_type before insert on catalog_items
  for each row execute function catalog_items_default_item_type();

alter table catalog_items alter column item_type set not null;
alter table catalog_items add constraint catalog_items_item_type_check
  check (item_type in ('PRODUCT','SERVICE','BOOTH','INTERNAL_COMPONENT'));

create index catalog_items_item_type_idx on catalog_items (item_type);

comment on column catalog_items.item_type is 'Catalog card type (PRODUCT/SERVICE/BOOTH/INTERNAL_COMPONENT). System property; category stays a separate user property. kind remains the readiness/generator profile.';

-- =========================================================================
-- 2. abf_code — the ABF price-list/warehouse code, deliberately SEPARATE from internal_code.
--    Nullable (INTERNAL_COMPONENT typically has none). Unique only when present, same
--    partial-index pattern as catalog_items_internal_code_key.
-- =========================================================================
alter table catalog_items add column abf_code text;

-- Backfill: every internal_code ever assigned before this migration was an ABF code (Batch
-- #2A/#2B only ever took codes from the ABF export — domain/abfCodeMatching.ts — and the M57/
-- L02/P86 seeds use the same ABF codes). ABF codes are exactly 3 characters: an uppercase
-- family letter + 2 digits/letters (T04, P86, M57, M8A, L02, I10, W21, U01, S10). Our own
-- non-ABF codes (GRAPHICS-FASCIA, GRAPHICS-FULL-WRAP, future INT-PANEL-950) never match.
update catalog_items
set abf_code = internal_code
where abf_code is null
  and internal_code ~ '^[A-Z][0-9A-Z]{2}$';

create unique index catalog_items_abf_code_key on catalog_items (abf_code) where abf_code is not null;

comment on column catalog_items.abf_code is 'ABF price-list code (nullable). Independent of internal_code: may change later without breaking internal references. Import identity for _IMPORT/KODY.xlsm.';

-- =========================================================================
-- 3. BOOTH package contents — booth -> item -> quantity -> included_in_package.
--    A booth/package (e.g. a future E/K stánek) can contain any other catalog item, including a
--    base typovka. included_in_package = true means "physically used and counted, never charged
--    to the customer again" (domain/catalogPackages.ts). ON DELETE RESTRICT on both sides — a
--    catalog item used in a package can never be hard-deleted.
-- =========================================================================
create table catalog_item_package_items (
  id uuid primary key default gen_random_uuid(),
  package_item_id uuid not null references catalog_items (id) on delete restrict,
  child_item_id uuid not null references catalog_items (id) on delete restrict,
  quantity numeric not null check (quantity > 0),
  included_in_package boolean not null default true,
  sort_order integer not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_item_package_items_not_self check (package_item_id <> child_item_id),
  constraint catalog_item_package_items_unique_child unique (package_item_id, child_item_id)
);

create index catalog_item_package_items_package_idx on catalog_item_package_items (package_item_id);
create index catalog_item_package_items_child_idx on catalog_item_package_items (child_item_id);

create trigger catalog_item_package_items_set_updated_at before update on catalog_item_package_items
  for each row execute function set_updated_at();

alter table catalog_item_package_items enable row level security;

-- =========================================================================
-- 4. Hard-delete guard. The app has no delete path for catalog items (archive only), but a
--    manual SQL delete must still never remove an item a saved project references. FKs already
--    cover pricing_entries / catalog_mappings / import_rows / package items; projects keep their
--    references inside JSONB (boothId, sceneObjects[].definitionId), which no FK can see — so
--    check the document text for either the row UUID or the item's own legacy document id.
-- =========================================================================
create or replace function catalog_items_prevent_referenced_delete() returns trigger as $$
declare
  legacy_id text := old.document ->> 'id';
begin
  if exists (
    select 1 from projects p
    where p.document::text like '%"' || old.id::text || '"%'
       or (legacy_id is not null and p.document::text like '%"' || legacy_id || '"%')
  ) then
    raise exception 'catalog_item % (%) is referenced by a saved project and cannot be deleted — archive it instead', old.id, coalesce(old.internal_code, old.display_name)
      using errcode = '23503';
  end if;
  return old;
end;
$$ language plpgsql;

create trigger catalog_items_prevent_referenced_delete before delete on catalog_items
  for each row execute function catalog_items_prevent_referenced_delete();
