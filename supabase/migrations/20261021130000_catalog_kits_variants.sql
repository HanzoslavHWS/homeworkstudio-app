-- V1-DATA-04 — kits, variants and substitutes (docs/V1_DATA_ARCHITECTURE.md 1.3, M6 + M7;
-- decisions A1, A4, A12, A14, A16, A17 in docs/V1_DATA_DECISIONS.md).
--
-- Additive: no catalog item, package line or project document is deleted or rewritten. Existing
-- package lines keep their id, child, quantity, flag, order and note; they only gain a line_key.
--   M6. catalog_variant_sets / catalog_variants — swatch books (e.g. carpet colours). A variant
--       is billed through price_item_id (M01 grey carpet, M02 other colour) and may carry its own
--       surcharge RULE. Amounts never live here: they belong to the future price-list versions
--       (V1-DATA-05), so a surcharge stays versioned and convertible like every other price.
--   M7. catalog_item_package_items becomes the kit line table shared by BOOTH and KIT:
--       stable line_key (unique per kit instead of unique child, so one component may repeat),
--       free text lines (A16), unit, default variant, included print allowance (A17), and
--       catalog_kit_line_substitutes for allowed replacements. Kits inside kits are refused (A14).
--       replace_catalog_kit_lines() saves one kit's whole content in one transaction.
-- Domain mirror: domain/catalogPackages.ts, domain/catalogVariants.ts, domain/catalogKitPricing.ts,
-- domain/catalogKitPrintAllowance.ts.

-- =========================================================================
-- M6. Variant sets and variants
-- =========================================================================
create table catalog_variant_sets (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]*$' and length(code) <= 64),
  name text not null check (btrim(name) <> ''),
  kind text not null default 'carpet' check (kind in ('carpet', 'finish', 'color', 'other')),
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table catalog_variant_sets is 'Swatch book (vzorník), e.g. KOBERCE-2026. Never deleted, only deactivated.';

create trigger catalog_variant_sets_set_updated_at before update on catalog_variant_sets for each row execute function set_updated_at();

create table catalog_variants (
  id uuid primary key default gen_random_uuid(),
  variant_set_id uuid not null references catalog_variant_sets (id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]*$' and length(code) <= 64),
  name text not null check (btrim(name) <> ''),
  name_en text,
  swatch_color text check (swatch_color is null or swatch_color ~ '^#[0-9a-fA-F]{6}$'),
  price_item_id uuid references catalog_items (id) on delete restrict,
  surcharge_rule text not null default 'none' check (surcharge_rule in ('none', 'price_difference', 'per_unit', 'fixed')),
  surcharge_unit_code text references catalog_units (code) on delete restrict,
  legacy_finish_id text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_variants_code_key unique (variant_set_id, code),
  constraint catalog_variants_per_unit_has_unit check (surcharge_rule <> 'per_unit' or surcharge_unit_code is not null)
);

comment on table catalog_variants is 'One colour/finish of a swatch book. price_item_id = the catalog card it is billed by (M01/M02). surcharge_rule: none | price_difference (price of price_item_id minus the default variant''s) | per_unit (own surcharge per surcharge_unit_code, e.g. Kč/m²) | fixed. Amounts come from price lists (V1-DATA-05), keyed by the variant id.';
comment on column catalog_variants.legacy_finish_id is 'FinishVariant.id used by older projects (project.carpetFinishId, e.g. carpet-grey). Keeps them resolvable.';

create unique index catalog_variants_legacy_finish_key on catalog_variants (variant_set_id, legacy_finish_id) where legacy_finish_id is not null;
create index catalog_variants_set_idx on catalog_variants (variant_set_id);
create index catalog_variants_price_item_idx on catalog_variants (price_item_id);

create trigger catalog_variants_set_updated_at before update on catalog_variants for each row execute function set_updated_at();

create or replace function catalog_variants_prevent_delete() returns trigger as $$
begin
  raise exception 'Vzorník ani variantu nelze smazat, lze je jen deaktivovat.' using errcode = 'P0001';
end;
$$ language plpgsql;

create trigger catalog_variant_sets_prevent_delete before delete on catalog_variant_sets for each row execute function catalog_variants_prevent_delete();
create trigger catalog_variants_prevent_delete before delete on catalog_variants for each row execute function catalog_variants_prevent_delete();

-- =========================================================================
-- M7. Kit lines (extension of catalog_item_package_items)
-- =========================================================================
alter table catalog_item_package_items
  add column line_key text,
  add column line_kind text not null default 'item',
  add column label text,
  add column label_en text,
  add column unit_code text references catalog_units (code) on delete restrict,
  add column variant_set_id uuid references catalog_variant_sets (id) on delete restrict,
  add column default_variant_id uuid references catalog_variants (id) on delete restrict,
  add column print_allowance jsonb;

-- Existing lines are unique per child, so a key derived from the child's code is unique after
-- numbering repeats (two children without any code both fall back to "polozka").
with keyed as (
  select
    line.id,
    coalesce(nullif(btrim(regexp_replace(lower(coalesce(item.abf_code, item.internal_code, '')), '[^a-z0-9]+', '-', 'g'), '-'), ''), 'polozka') as base,
    row_number() over (
      partition by line.package_item_id,
        coalesce(nullif(btrim(regexp_replace(lower(coalesce(item.abf_code, item.internal_code, '')), '[^a-z0-9]+', '-', 'g'), '-'), ''), 'polozka')
      order by line.sort_order, line.id
    ) as n
  from catalog_item_package_items line
  join catalog_items item on item.id = line.child_item_id
)
update catalog_item_package_items line
set line_key = left(keyed.base, 56) || case when keyed.n > 1 then '-' || keyed.n else '' end
from keyed
where keyed.id = line.id and line.line_key is null;

alter table catalog_item_package_items
  alter column line_key set not null,
  alter column child_item_id drop not null,
  drop constraint catalog_item_package_items_unique_child,
  add constraint catalog_item_package_items_line_key_format check (line_key ~ '^[a-z0-9][a-z0-9-]*$' and length(line_key) <= 64),
  add constraint catalog_item_package_items_line_key_unique unique (package_item_id, line_key),
  add constraint catalog_item_package_items_line_kind check (line_kind in ('item', 'text')),
  add constraint catalog_item_package_items_kind_child check ((line_kind = 'item') = (child_item_id is not null)),
  -- A16: a text line has a name, no price of its own, no variant and no print allowance.
  add constraint catalog_item_package_items_text_line check (
    line_kind = 'item'
    or (btrim(coalesce(label, '')) <> '' and included_in_package and variant_set_id is null and default_variant_id is null and print_allowance is null)
  ),
  add constraint catalog_item_package_items_default_variant_needs_set check (default_variant_id is null or variant_set_id is not null),
  add constraint catalog_item_package_items_print_allowance_array check (print_allowance is null or jsonb_typeof(print_allowance) = 'array');

comment on table catalog_item_package_items is 'Kit lines of a BOOTH or KIT card (shared mechanism, decision A1). Identity = (package_item_id, line_key); the same component may appear on several lines.';
comment on column catalog_item_package_items.line_key is 'Stable, readable line id inside the kit (koberec, elektro, stena-zadni). Never changes when the component changes; substitutes, snapshots and imports refer to it.';
comment on column catalog_item_package_items.line_kind is 'item = catalog component (child_item_id); text = free text line (label), always included, never priced (A16).';
comment on column catalog_item_package_items.print_allowance is 'Graphics included in the kit price (A17): [{surfaceTypeId?, printSurfaceIds?, unitCode: bm|m2|ks, includedQuantity}]. Only the overflow above includedQuantity is charged; different types/units never offset each other.';

create index catalog_item_package_items_variant_set_idx on catalog_item_package_items (variant_set_id);

-- A14 + A1: only BOOTH/KIT own lines, and a line never points to another BOOTH/KIT. Checked on
-- write only, so rows stored before this migration are kept as they are.
create or replace function catalog_item_package_items_validate() returns trigger as $$
declare
  owner_type text;
  child_type text;
begin
  select item_type into owner_type from catalog_items where id = new.package_item_id;
  if owner_type is distinct from 'BOOTH' and owner_type is distinct from 'KIT' then
    raise exception 'Obsah kompletu lze nastavit jen u karty typu Stánek nebo Komplet.' using errcode = 'P0001';
  end if;
  if new.child_item_id is not null then
    select item_type into child_type from catalog_items where id = new.child_item_id;
    if child_type in ('BOOTH', 'KIT') then
      raise exception 'Komplet nemůže obsahovat jiný komplet ani stánek (rozhodnutí A14).' using errcode = 'P0001';
    end if;
  end if;
  if new.default_variant_id is not null and not exists (
    select 1 from catalog_variants where id = new.default_variant_id and variant_set_id = new.variant_set_id
  ) then
    raise exception 'Výchozí varianta nepatří do vybraného vzorníku.' using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger catalog_item_package_items_validate before insert or update on catalog_item_package_items
  for each row execute function catalog_item_package_items_validate();

-- =========================================================================
-- Allowed substitutes of a kit line
-- =========================================================================
create table catalog_kit_line_substitutes (
  id uuid primary key default gen_random_uuid(),
  kit_line_id uuid not null references catalog_item_package_items (id) on delete cascade,
  substitute_item_id uuid not null references catalog_items (id) on delete restrict,
  substitute_variant_id uuid references catalog_variants (id) on delete restrict,
  surcharge_rule text not null default 'price_difference' check (surcharge_rule in ('price_difference', 'fixed', 'per_unit', 'none')),
  surcharge_unit_code text references catalog_units (code) on delete restrict,
  quantity_factor numeric not null default 1 check (quantity_factor > 0),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_kit_line_substitutes_per_unit_has_unit check (surcharge_rule <> 'per_unit' or surcharge_unit_code is not null)
);

comment on table catalog_kit_line_substitutes is 'Allowed replacements of one kit line (bound to the line, not to the component). The substitute REPLACES the line''s component. price_difference = price(substitute) - price(original) in the same price version, never below zero (A4). fixed/per_unit amounts come from price lists (V1-DATA-05), keyed by this row''s id.';

create unique index catalog_kit_line_substitutes_key on catalog_kit_line_substitutes (kit_line_id, substitute_item_id, coalesce(substitute_variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index catalog_kit_line_substitutes_item_idx on catalog_kit_line_substitutes (substitute_item_id);

create trigger catalog_kit_line_substitutes_set_updated_at before update on catalog_kit_line_substitutes for each row execute function set_updated_at();

create or replace function catalog_kit_line_substitutes_validate() returns trigger as $$
declare
  line record;
  substitute_type text;
begin
  select line_kind, child_item_id into line from catalog_item_package_items where id = new.kit_line_id;
  if line.line_kind <> 'item' then
    raise exception 'Textová položka kompletu nemůže mít náhrady.' using errcode = 'P0001';
  end if;
  if new.substitute_item_id = line.child_item_id and new.substitute_variant_id is null then
    raise exception 'Náhrada musí být jiná komponenta nebo jiná varianta.' using errcode = 'P0001';
  end if;
  select item_type into substitute_type from catalog_items where id = new.substitute_item_id;
  if substitute_type in ('BOOTH', 'KIT') then
    raise exception 'Náhradou nemůže být komplet ani stánek (rozhodnutí A14).' using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger catalog_kit_line_substitutes_validate before insert or update on catalog_kit_line_substitutes
  for each row execute function catalog_kit_line_substitutes_validate();

-- =========================================================================
-- Transactional save of one kit's content
-- =========================================================================
-- p_lines: [{line_key, line_kind, child_item_id, label, label_en, quantity, unit_code,
--   included_in_package, note, variant_set_id, default_variant_id, print_allowance,
--   substitutes: [{substitute_item_id, substitute_variant_id, surcharge_rule,
--   surcharge_unit_code, quantity_factor, note}]}] in display order.
-- Lines are matched by line_key: kept lines keep their id, missing ones are removed (with their
-- substitutes), new ones inserted. The domain validates first (domain/catalogPackages.ts);
-- constraints and triggers above are the safety net.
create or replace function replace_catalog_kit_lines(p_package_item_id uuid, p_lines jsonb) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_line jsonb;
  v_line_id uuid;
  v_index integer := 0;
begin
  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'p_lines musí být pole.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) where coalesce(value ->> 'line_key', '') = '') then
    raise exception 'Každý řádek kompletu musí mít line_key.' using errcode = '22023';
  end if;
  perform 1 from catalog_items where id = p_package_item_id for update;
  if not found then
    raise exception 'Komplet nebyl v katalogu nalezen.' using errcode = 'P0002';
  end if;

  delete from catalog_item_package_items
  where package_item_id = p_package_item_id
    and line_key not in (select value ->> 'line_key' from jsonb_array_elements(p_lines));

  for v_line in select value from jsonb_array_elements(p_lines) loop
    insert into catalog_item_package_items (
      package_item_id, line_key, line_kind, child_item_id, label, label_en, quantity, unit_code,
      included_in_package, sort_order, note, variant_set_id, default_variant_id, print_allowance
    ) values (
      p_package_item_id,
      v_line ->> 'line_key',
      coalesce(v_line ->> 'line_kind', 'item'),
      nullif(v_line ->> 'child_item_id', '')::uuid,
      nullif(v_line ->> 'label', ''),
      nullif(v_line ->> 'label_en', ''),
      (v_line ->> 'quantity')::numeric,
      nullif(v_line ->> 'unit_code', ''),
      coalesce((v_line ->> 'included_in_package')::boolean, true),
      v_index,
      nullif(v_line ->> 'note', ''),
      nullif(v_line ->> 'variant_set_id', '')::uuid,
      nullif(v_line ->> 'default_variant_id', '')::uuid,
      case when jsonb_typeof(v_line -> 'print_allowance') = 'array' and jsonb_array_length(v_line -> 'print_allowance') > 0 then v_line -> 'print_allowance' end
    )
    on conflict (package_item_id, line_key) do update set
      line_kind = excluded.line_kind,
      child_item_id = excluded.child_item_id,
      label = excluded.label,
      label_en = excluded.label_en,
      quantity = excluded.quantity,
      unit_code = excluded.unit_code,
      included_in_package = excluded.included_in_package,
      sort_order = excluded.sort_order,
      note = excluded.note,
      variant_set_id = excluded.variant_set_id,
      default_variant_id = excluded.default_variant_id,
      print_allowance = excluded.print_allowance
    returning id into v_line_id;

    delete from catalog_kit_line_substitutes where kit_line_id = v_line_id;
    insert into catalog_kit_line_substitutes (
      kit_line_id, substitute_item_id, substitute_variant_id, surcharge_rule, surcharge_unit_code, quantity_factor, sort_order, note
    )
    select
      v_line_id,
      (sub.value ->> 'substitute_item_id')::uuid,
      nullif(sub.value ->> 'substitute_variant_id', '')::uuid,
      coalesce(sub.value ->> 'surcharge_rule', 'price_difference'),
      nullif(sub.value ->> 'surcharge_unit_code', ''),
      coalesce((sub.value ->> 'quantity_factor')::numeric, 1),
      sub.ordinality - 1,
      nullif(sub.value ->> 'note', '')
    from jsonb_array_elements(coalesce(v_line -> 'substitutes', '[]'::jsonb)) with ordinality as sub(value, ordinality);

    v_index := v_index + 1;
  end loop;
end;
$$;

revoke all on function replace_catalog_kit_lines(uuid, jsonb) from public, anon, authenticated;
grant execute on function replace_catalog_kit_lines(uuid, jsonb) to service_role;

-- Browser must never talk to Postgres directly — RLS with zero policies, like every table.
alter table catalog_variant_sets enable row level security;
alter table catalog_variants enable row level security;
alter table catalog_kit_line_substitutes enable row level security;
