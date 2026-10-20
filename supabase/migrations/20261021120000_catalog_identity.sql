-- V1-DATA-03 — final identity of catalog items (docs/V1_DATA_ARCHITECTURE.md 1.2, M1/M2/M5).
--
-- Additive only: no column, row or alias is dropped, nothing in a project document is touched.
--   1. catalog_units — shared unit register (ks, m², bm, m³, den, paušál). Combined units such as
--      ks/den or m²/akce are NOT merged with their base unit: they stay unmapped until a combined
--      unit with an approved conversion rule is added to this register.
--   2. catalog_items gets official_name_en (official English ABF name) and unit_code (FK to the
--      register). The free-text `unit` column stays as the legacy/display value.
--   3. item_type gains KIT (a stand-alone kit without its own geometry). BOOTH keeps its own
--      package contents and is never converted to KIT (decision A1).
--   4. catalog_item_aliases — one place for alternative names and codes of a catalog item:
--      general (realization_company_id NULL) or per realization company from the V1-DATA-02
--      register. The same text may mean different items at different companies.
-- Domain mirror: domain/catalogUnits.ts, domain/catalogItemAliases.ts, domain/catalogItemTypes.ts.

-- =========================================================================
-- 1. Units
-- =========================================================================
create table catalog_units (
  code text primary key check (code ~ '^[a-z0-9_]+$'),
  symbol text not null check (btrim(symbol) <> ''),
  name_cs text not null,
  name_en text not null,
  quantity_kind text not null check (quantity_kind in ('count', 'area', 'length', 'volume', 'time', 'flat')),
  is_combined boolean not null default false,
  aliases text[] not null default '{}',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table catalog_units is 'Shared unit register. aliases = normalized spellings that safely mean exactly this unit (normalizeUnitText in domain/catalogUnits.ts). A combined unit (ks/den, m²/akce) is a separate row with is_combined = true, added only with an approved conversion rule.';

create trigger catalog_units_set_updated_at before update on catalog_units for each row execute function set_updated_at();

insert into catalog_units (code, symbol, name_cs, name_en, quantity_kind, aliases, sort_order) values
  ('ks', 'ks', 'kus', 'piece', 'count', array['ks', 'kus', 'kusy', 'kusu', 'pc', 'pcs'], 10),
  ('m2', 'm²', 'metr čtvereční', 'square metre', 'area', array['m2', 'metrctverecni'], 20),
  ('bm', 'bm', 'běžný metr', 'running metre', 'length', array['bm', 'beznymetr'], 30),
  ('m3', 'm³', 'metr krychlový', 'cubic metre', 'volume', array['m3', 'metrkrychlovy'], 40),
  ('den', 'den', 'den', 'day', 'time', array['den', 'dny', 'dni', 'dnu', 'day', 'days'], 50),
  ('pausal', 'paušál', 'paušál', 'flat rate', 'flat', array['pausal', 'paus', 'flat'], 60);

-- =========================================================================
-- 2. New identity columns
-- =========================================================================
alter table catalog_items
  add column official_name_en text,
  add column unit_code text references catalog_units (code) on delete restrict;

create index catalog_items_unit_code_idx on catalog_items (unit_code);

comment on column catalog_items.internal_code is 'Generátorový kód. May equal abf_code (decision A8); never generated automatically for internal components.';
comment on column catalog_items.display_name is 'Interní název HomeworkStudio.';
comment on column catalog_items.official_name is 'Oficiální český název ABF (KODY.xlsm).';
comment on column catalog_items.official_name_en is 'Oficiální anglický název ABF (KODY.xlsm).';
comment on column catalog_items.unit_code is 'Unit from catalog_units. NULL = not chosen yet, or the legacy `unit` text is a combined/unknown unit that must not be merged.';

-- The KODY import kept the English ABF name only inside the document.
update catalog_items
set official_name_en = nullif(btrim(document -> 'abfImport' ->> 'abfNameEn'), '')
where official_name_en is null
  and nullif(btrim(document -> 'abfImport' ->> 'abfNameEn'), '') is not null;

-- Only exact, unambiguous spellings are mapped. Anything with "/" (ks/den, m²/akce) or an unknown
-- value (m, mm, free text) keeps unit_code NULL and stays visible as the legacy text.
update catalog_items
set unit_code = case lower(btrim(unit))
  when 'ks' then 'ks' when 'ks.' then 'ks' when 'kus' then 'ks' when 'kusy' then 'ks'
  when 'm2' then 'm2' when 'm²' then 'm2'
  when 'bm' then 'bm' when 'b.m.' then 'bm'
  when 'm3' then 'm3' when 'm³' then 'm3'
  when 'den' then 'den' when 'dny' then 'den'
  when 'paušál' then 'pausal' when 'pausal' then 'pausal'
end
where unit_code is null and unit is not null;

-- =========================================================================
-- 3. KIT item type
-- =========================================================================
alter table catalog_items drop constraint catalog_items_item_type_check;
alter table catalog_items add constraint catalog_items_item_type_check
  check (item_type in ('PRODUCT', 'SERVICE', 'BOOTH', 'INTERNAL_COMPONENT', 'KIT'));

comment on column catalog_items.item_type is 'Catalog card type (PRODUCT/SERVICE/BOOTH/INTERNAL_COMPONENT/KIT). System property; category stays a separate user property. kind remains the readiness/generator profile.';

-- =========================================================================
-- 4. Aliases of catalog items (names and codes, general or per realization company)
-- =========================================================================
create table catalog_item_aliases (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid not null references catalog_items (id) on delete restrict,
  realization_company_id text references print_surface_realization_companies (id) on delete restrict,
  alias_kind text not null check (alias_kind in ('name', 'code')),
  alias_text text not null check (btrim(alias_text) <> ''),
  normalized_text text not null check (normalized_text <> ''),
  unit_code text references catalog_units (code) on delete restrict,
  source text not null default 'manual' check (source in ('manual', 'import', 'settlement', 'abf')),
  status text not null default 'confirmed' check (status in ('suggested', 'confirmed')),
  note text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table catalog_item_aliases is 'Alternative names and codes of catalog items. realization_company_id NULL = general alias; set = the name/code that realization company uses (the same text may mean another item at another company). Rows are deactivated, never deleted.';
comment on column catalog_item_aliases.normalized_text is 'normalizeCatalogAliasText in domain/catalogItemAliases.ts: names lower-case without diacritics and with single spaces, codes upper-case without whitespace.';
comment on column catalog_item_aliases.unit_code is 'Unit in which the company bills the item, when it differs from the card.';

-- One active alias text of one kind leads to exactly one item — per company, and once more among general aliases.
create unique index catalog_item_aliases_active_key on catalog_item_aliases (coalesce(realization_company_id, ''), alias_kind, normalized_text) where is_active;
create index catalog_item_aliases_item_idx on catalog_item_aliases (catalog_item_id);
create index catalog_item_aliases_company_idx on catalog_item_aliases (realization_company_id);

create trigger catalog_item_aliases_set_updated_at before update on catalog_item_aliases for each row execute function set_updated_at();

create or replace function catalog_item_aliases_prevent_delete() returns trigger as $$
begin
  raise exception 'Alias katalogové položky nelze smazat, lze ho jen deaktivovat.' using errcode = 'P0001';
end;
$$ language plpgsql;

create trigger catalog_item_aliases_prevent_delete before delete on catalog_item_aliases for each row execute function catalog_item_aliases_prevent_delete();

-- Browser must never talk to Postgres directly — RLS with zero policies, like every table.
alter table catalog_units enable row level security;
alter table catalog_item_aliases enable row level security;
