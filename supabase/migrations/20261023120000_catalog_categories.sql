-- V1-CATALOG: catalog category register (Druh komponenty → Kategorie).
--
-- Non-destructive: one new register table, seeded with the categories the application already
-- uses (catalog_items.category values keep their exact ids: chairs, Nábytek, T. služby, …) plus
-- the new categories of the five component groups. catalog_items is NOT altered — category stays
-- a text column without a foreign key, so historical values remain readable; the application
-- validates new assignments against this register (domain/catalogClassification.ts). Categories
-- are never deleted, only deactivated. Seed = BUILT_IN_CATALOG_CATEGORIES (kept in sync by test).

create table catalog_categories (
  id text primary key check (btrim(id) <> '' and length(id) <= 64),
  name text not null check (btrim(name) <> ''),
  component_group text not null check (component_group in ('product', 'graphics', 'technical_service', 'internal_component', 'technical_point')),
  kinds text[] not null check (cardinality(kinds) > 0),
  description text,
  is_active boolean not null default true,
  sort_order integer not null default 1000,
  service_category text,
  price_category text check (price_category is null or price_category in ('standard', 'electricity')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table catalog_categories is 'Katalog: categories of the five component groups (Produkt, Grafika, Technická služba, Interní komponenta, Technický bod). kinds = internal catalog_items.kind values allowed in the category (first = default). service_category = Technické rastry category; price_category = pricing classification implied (null = derived from the group). Never deleted, only deactivated.';

create trigger catalog_categories_set_updated_at before update on catalog_categories for each row execute function set_updated_at();

create function catalog_categories_prevent_delete() returns trigger as $$
begin
  raise exception 'Kategorii katalogu nelze smazat, lze ji jen deaktivovat.' using errcode = 'P0001';
end;
$$ language plpgsql;

create trigger catalog_categories_prevent_delete before delete on catalog_categories for each row execute function catalog_categories_prevent_delete();

insert into catalog_categories (id, name, component_group, kinds, description, is_active, sort_order, service_category, price_category) values
  ('chairs', 'Židle', 'product', array['furniture'], null, true, 10, null, null),
  ('product-tables', 'Stoly', 'product', array['furniture'], null, true, 20, null, null),
  ('product-counters', 'Pulty', 'product', array['furniture'], null, true, 30, null, null),
  ('Kuchyňka', 'Kuchyňka', 'product', array['furniture', 'other'], null, true, 40, null, null),
  ('Nábytek', 'Ostatní mobiliář', 'product', array['furniture', 'other'], null, true, 50, null, null),
  ('product-carpets', 'Koberce', 'product', array['floor_finish'], null, true, 60, null, null),
  ('Podlaha', 'Podlaha', 'product', array['floor_finish'], null, true, 70, null, null),
  ('Osvětlení', 'Osvětlení', 'product', array['other', 'furniture'], null, true, 80, null, null),
  ('Světlo', 'Světlo / elektro (ABF)', 'product', array['other', 'furniture'], null, true, 90, null, null),
  ('Octanorm', 'Octanorm', 'product', array['furniture', 'construction', 'other'], null, true, 100, null, null),
  ('Stavba', 'Stavba', 'product', array['construction'], null, true, 110, null, null),
  ('Úvaz', 'Úvaz (rigging)', 'product', array['construction'], null, true, 120, null, null),
  ('Ostatní', 'Ostatní produkty', 'product', array['other', 'furniture'], null, true, 130, null, null),
  ('graphics-fascia', 'Límec (bm)', 'graphics', array['graphics_service'], null, true, 210, null, null),
  ('graphics-full-wrap', 'Celopolep (m²)', 'graphics', array['graphics_service'], null, true, 220, null, null),
  ('graphics-counter', 'Polep pultu (m²)', 'graphics', array['graphics_service'], null, true, 230, null, null),
  ('graphics-other', 'Ostatní grafika', 'graphics', array['graphics_service'], null, true, 240, null, null),
  ('service-electricity', 'Elektřina', 'technical_service', array['service'], null, true, 310, 'electricity', 'electricity'),
  ('service-internet', 'Internet', 'technical_service', array['service'], null, true, 320, 'internet', null),
  ('service-cleaning', 'Úklid', 'technical_service', array['service'], null, true, 330, 'cleaning', null),
  ('service-water', 'Voda', 'technical_service', array['service'], null, true, 340, 'water', null),
  ('service-waste', 'Odpad', 'technical_service', array['service'], null, true, 350, 'waste', null),
  ('T. služby', 'Ostatní technické služby', 'technical_service', array['service'], null, true, 360, 'other', null),
  ('services', 'Služby (původní obecná kategorie)', 'technical_service', array['service', 'graphics_service'], 'Historická obecná kategorie. Nové karty zařaďte do konkrétní technické služby nebo grafiky.', false, 390, null, null),
  ('Sloupky', 'Sloupky', 'internal_component', array['booth_component', 'construction'], null, true, 410, null, null),
  ('Panely / stěny', 'Panely / stěny', 'internal_component', array['booth_component', 'construction'], null, true, 420, null, null),
  ('Límce', 'Límce (konstrukční profil)', 'internal_component', array['booth_component', 'construction'], null, true, 430, null, null),
  ('Dveře', 'Dveře', 'internal_component', array['booth_component', 'construction'], null, true, 440, null, null),
  ('Zázemí / konstrukce', 'Konstrukční prvky / zázemí', 'internal_component', array['construction', 'booth_component'], null, true, 450, null, null),
  ('internal-other', 'Ostatní interní komponenty', 'internal_component', array['other', 'booth_component', 'construction'], null, true, 460, null, null),
  ('point-electricity', 'Elektro bod', 'technical_point', array['technical_point'], null, true, 510, 'electricity', null),
  ('point-internet', 'Internetový bod', 'technical_point', array['technical_point'], null, true, 520, 'internet', null),
  ('point-water', 'Vodní bod', 'technical_point', array['technical_point'], null, true, 530, 'water', null),
  ('point-other', 'Ostatní technické body', 'technical_point', array['technical_point'], null, true, 540, 'other', null);

-- Browser must never talk to Postgres directly — RLS with zero policies, like every table.
alter table catalog_categories enable row level security;
