-- V1-DATA-05 — versioned price lists (docs/V1_DATA_ARCHITECTURE.md 1.4, M8; decisions A3, A5, A11,
-- A18 and the V1-DATA-05 rules in docs/V1_DATA_DECISIONS.md section 8).
--
-- Additive: no existing table, row or project document is rewritten. The legacy model
-- (price_lists + pricing_entries + document.pricingEntries) stays exactly as it is and keeps
-- serving the generator, print surfaces and the customer catalog until V1-DATA-07.
--
-- Why new tables instead of price_lists.kind (deviation from M8, approved 2026-10-22): five legacy
-- readers list every price_lists row. A purchase list must never show up in any of them.
--
--   versioned_price_lists   one header per list: base (sale, shared), electricity (sale, per event
--                           by assignment), purchase (shared by the realization firms linked to it).
--   price_list_versions     draft -> published -> archived. Stores its own EUR rate and rounding.
--                           valid_from / valid_to are informational only: nothing resolves a price by
--                           date. Published versions are immutable; a fix is a new version.
--   price_list_entries      SALE prices of one version (CZK, EUR derived / direct / manual / none).
--   price_list_surcharges   SALE amounts of fixed / per-unit surcharges of variants and kit substitutes.
--                           Substitutes are keyed by (kit, line_key, substitute item, substitute variant):
--                           replace_catalog_kit_lines() recreates substitute rows on every kit save.
--   purchase_price_entries  PURCHASE prices, in their own table so no sale query can ever carry them.
--   purchase_price_list_companies  which realization firms buy by which purchase list.
--   event_price_assignments explicit event -> version assignment (base, electricity) with history.
--                           The event date never switches a price list.
--   catalog_items.price_category  standard | electricity; electricity services are told apart by this
--                           category, not by the ABF code prefix.
-- Domain mirror: domain/priceVersions.ts.

-- =========================================================================
-- 0. Electricity category of catalog cards
-- =========================================================================
alter table catalog_items add column price_category text not null default 'standard';
alter table catalog_items add constraint catalog_items_price_category_check check (price_category in ('standard', 'electricity'));

comment on column catalog_items.price_category is 'Pricing category. electricity = service priced by the electricity price list assigned to the event (decision A11 as revised in V1-DATA-05). Source of truth; the ABF code prefix is not.';

-- One-time initial classification (approved 2026-10-22): SERVICE cards with an ABF electricity code
-- (L + 2 characters, e.g. L02). From now on only the category decides.
update catalog_items
set price_category = 'electricity'
where item_type = 'SERVICE' and abf_code ~ '^L[0-9A-Z]{2}$' and price_category = 'standard';

-- =========================================================================
-- 1. Price list headers
-- =========================================================================
create table versioned_price_lists (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]*$' and length(code) <= 64),
  name text not null check (btrim(name) <> ''),
  kind text not null check (kind in ('base', 'electricity', 'purchase')),
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table versioned_price_lists is 'Versioned price list header (V1-DATA-05). base = shared sale list of components and furniture; electricity = sale prices of electricity services, used by the events it is assigned to; purchase = shared purchase prices (Creativ Expo, Gendai, MAC Praha today). Never deleted, only deactivated.';

create trigger versioned_price_lists_set_updated_at before update on versioned_price_lists for each row execute function set_updated_at();

create or replace function versioned_price_lists_guard() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Ceník nelze smazat, lze jej jen deaktivovat.' using errcode = 'P0001';
  end if;
  if new.kind is distinct from old.kind then
    raise exception 'Druh ceníku nelze změnit.' using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger versioned_price_lists_guard before update or delete on versioned_price_lists for each row execute function versioned_price_lists_guard();

-- =========================================================================
-- 2. Versions
-- =========================================================================
create table price_list_versions (
  id uuid primary key default gen_random_uuid(),
  price_list_id uuid not null references versioned_price_lists (id) on delete restrict,
  version_no integer not null check (version_no > 0),
  label text,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  valid_from date,
  valid_to date,
  eur_rate numeric(12, 4) not null default 24.17 check (eur_rate > 0),
  eur_rounding_mode text not null default 'ceil' check (eur_rounding_mode in ('ceil', 'round', 'floor')),
  eur_rounding_step numeric(8, 2) not null default 1 check (eur_rounding_step in (0.01, 0.1, 0.5, 1, 5, 10)),
  based_on_version_id uuid references price_list_versions (id) on delete restrict,
  note text,
  created_by text,
  published_at timestamptz,
  published_by text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_list_versions_no_key unique (price_list_id, version_no),
  constraint price_list_versions_valid_range check (valid_to is null or valid_from is null or valid_to >= valid_from),
  constraint price_list_versions_published_stamp check (status = 'draft' or published_at is not null)
);

comment on table price_list_versions is 'One version of a versioned price list. Published = immutable (only published -> archived is allowed); a fix or a new EUR rate is a new version. valid_from / valid_to are informational (evidenční) only — an event uses the version explicitly assigned to it, never the one valid at its date.';
comment on column price_list_versions.eur_rate is 'CZK per 1 EUR stored in this version. Changing it in a published version is refused; publish a new version instead, so historical prices never change.';
comment on column price_list_versions.eur_rounding_mode is 'Rounding of a derived EUR UNIT price (never of a total): ceil | round | floor, to eur_rounding_step. Default ceil to 1 EUR (21.35 -> 22).';

create index price_list_versions_list_idx on price_list_versions (price_list_id);

create trigger price_list_versions_set_updated_at before update on price_list_versions for each row execute function set_updated_at();

-- Publishing goes through publish_price_list_version() only; it marks the transaction with this
-- setting so the guard below can tell it from a plain UPDATE.
create or replace function price_list_versions_guard() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Publikovanou ani archivovanou verzi ceníku nelze smazat.' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'Nová verze ceníku musí vzniknout jako koncept.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.price_list_id is distinct from old.price_list_id or new.version_no is distinct from old.version_no then
    raise exception 'Verzi nelze přesunout do jiného ceníku ani přečíslovat.' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if new.status = 'published' and coalesce(current_setting('app.publish_price_list_version', true), '') <> old.id::text then
      raise exception 'Verzi ceníku lze publikovat jen akcí Publikovat.' using errcode = 'P0001';
    end if;
    if new.status = 'archived' then
      raise exception 'Koncept nelze archivovat, lze jej smazat.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status = 'published' and new.status = 'archived'
    and (to_jsonb(new) - array['status', 'archived_at', 'updated_at']) = (to_jsonb(old) - array['status', 'archived_at', 'updated_at']) then
    return new;
  end if;
  raise exception 'Publikovaná verze ceníku je neměnná. Pro opravu vytvořte novou verzi.' using errcode = 'P0001';
end;
$$ language plpgsql;

create trigger price_list_versions_guard before insert or update or delete on price_list_versions for each row execute function price_list_versions_guard();

-- Rows of a version can be written only while the version is a draft.
create or replace function price_version_rows_guard() returns trigger as $$
declare
  v_status text;
  v_version_id uuid;
begin
  v_version_id := case when tg_op = 'DELETE' then old.version_id else new.version_id end;
  select status into v_status from price_list_versions where id = v_version_id;
  -- Deleting a draft version cascades to its rows: the version row is already gone here.
  if v_status is null and tg_op = 'DELETE' then
    return old;
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'Publikovaná verze ceníku je neměnná. Pro opravu vytvořte novou verzi.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.version_id is distinct from old.version_id then
    raise exception 'Řádek nelze přesunout do jiné verze.' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$ language plpgsql;

-- =========================================================================
-- 3. Sale prices
-- =========================================================================
create table price_list_entries (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references price_list_versions (id) on delete cascade,
  catalog_item_id uuid not null references catalog_items (id) on delete restrict,
  variant_id uuid references catalog_variants (id) on delete restrict,
  price_mode text not null default 'fixed' check (price_mode in ('fixed', 'individual', 'included')),
  sale_czk numeric(12, 2) check (sale_czk is null or sale_czk >= 0),
  eur_mode text not null default 'derived' check (eur_mode in ('derived', 'direct', 'manual', 'none')),
  sale_eur numeric(12, 2) check (sale_eur is null or sale_eur >= 0),
  unit_code text references catalog_units (code) on delete restrict,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- individual (on request) and included carry no amount: missing never becomes 0.
  constraint price_list_entries_amounts_only_fixed check (price_mode = 'fixed' or (sale_czk is null and sale_eur is null)),
  constraint price_list_entries_fixed_has_price check (price_mode <> 'fixed' or sale_czk is not null or (eur_mode = 'direct' and sale_eur is not null)),
  -- derived / manual start from the CZK price; direct is set in EUR (CZK optional); none = not sold in EUR.
  constraint price_list_entries_eur_amount check (
    price_mode <> 'fixed'
    or (eur_mode in ('direct', 'manual') and sale_eur is not null)
    or (eur_mode in ('derived', 'none') and sale_eur is null)
  ),
  constraint price_list_entries_derived_needs_czk check (price_mode <> 'fixed' or eur_mode not in ('derived', 'manual') or sale_czk is not null)
);

comment on table price_list_entries is 'Sale unit prices of one price list version, always without VAT. variant_id = price of one variant (e.g. carpet colour); without it the price applies to every variant of the card.';
comment on column price_list_entries.eur_mode is 'derived = sale_czk / version eur_rate rounded by the version rule; direct = price set in EUR (sale_eur); manual = derived price overridden by hand (sale_eur, recorded as manual); none = not sold in EUR.';

create unique index price_list_entries_key on price_list_entries (version_id, catalog_item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index price_list_entries_item_idx on price_list_entries (catalog_item_id);

create trigger price_list_entries_set_updated_at before update on price_list_entries for each row execute function set_updated_at();
create trigger price_list_entries_guard before insert or update or delete on price_list_entries for each row execute function price_version_rows_guard();

-- =========================================================================
-- 4. Surcharge amounts (variants, kit substitutes)
-- =========================================================================
create table price_list_surcharges (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references price_list_versions (id) on delete cascade,
  target_kind text not null check (target_kind in ('variant', 'substitute')),
  variant_id uuid references catalog_variants (id) on delete restrict,
  kit_item_id uuid references catalog_items (id) on delete restrict,
  line_key text,
  substitute_item_id uuid references catalog_items (id) on delete restrict,
  substitute_variant_id uuid references catalog_variants (id) on delete restrict,
  amount_czk numeric(12, 2) check (amount_czk is null or amount_czk >= 0),
  eur_mode text not null default 'derived' check (eur_mode in ('derived', 'direct', 'manual', 'none')),
  amount_eur numeric(12, 2) check (amount_eur is null or amount_eur >= 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_list_surcharges_target check (
    (target_kind = 'variant' and variant_id is not null and kit_item_id is null and line_key is null and substitute_item_id is null and substitute_variant_id is null)
    or (target_kind = 'substitute' and variant_id is null and kit_item_id is not null and line_key is not null and substitute_item_id is not null)
  ),
  constraint price_list_surcharges_has_amount check (amount_czk is not null or (eur_mode = 'direct' and amount_eur is not null)),
  constraint price_list_surcharges_eur_amount check (
    (eur_mode in ('direct', 'manual') and amount_eur is not null) or (eur_mode in ('derived', 'none') and amount_eur is null)
  ),
  constraint price_list_surcharges_derived_needs_czk check (eur_mode not in ('derived', 'manual') or amount_czk is not null)
);

comment on table price_list_surcharges is 'Amounts of fixed / per_unit surcharges (V1-DATA-04 rules) in one sale version. variant = surcharge of a swatch-book variant (keyed by variant id); substitute = surcharge of an allowed kit substitute keyed by (kit_item_id, line_key, substitute_item_id, substitute_variant_id) because substitute rows are recreated on every kit save. price_difference needs no row here.';

create unique index price_list_surcharges_key on price_list_surcharges (
  version_id,
  target_kind,
  coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(kit_item_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(line_key, ''),
  coalesce(substitute_item_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(substitute_variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

create trigger price_list_surcharges_set_updated_at before update on price_list_surcharges for each row execute function set_updated_at();
create trigger price_list_surcharges_guard before insert or update or delete on price_list_surcharges for each row execute function price_version_rows_guard();

-- =========================================================================
-- 5. Purchase prices (separate table and API; never part of a sale read)
-- =========================================================================
create table purchase_price_entries (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references price_list_versions (id) on delete cascade,
  catalog_item_id uuid not null references catalog_items (id) on delete restrict,
  variant_id uuid references catalog_variants (id) on delete restrict,
  purchase_czk numeric(12, 2) not null check (purchase_czk >= 0),
  unit_code text references catalog_units (code) on delete restrict,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table purchase_price_entries is 'INTERNAL purchase unit prices (CZK, without VAT) of a purchase price list version. Never exposed in the customer catalog, offers or customer exports. Firm-specific names, codes and units stay in catalog_item_aliases (V1-DATA-03).';

create unique index purchase_price_entries_key on purchase_price_entries (version_id, catalog_item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index purchase_price_entries_item_idx on purchase_price_entries (catalog_item_id);

create trigger purchase_price_entries_set_updated_at before update on purchase_price_entries for each row execute function set_updated_at();
create trigger purchase_price_entries_guard before insert or update or delete on purchase_price_entries for each row execute function price_version_rows_guard();

-- Entry tables must match the kind of their list: sale rows only in base/electricity, purchase rows only in purchase.
create or replace function price_version_rows_kind_check() returns trigger as $$
declare
  v_kind text;
begin
  select list.kind into v_kind
  from price_list_versions version join versioned_price_lists list on list.id = version.price_list_id
  where version.id = new.version_id;
  if tg_table_name = 'purchase_price_entries' and v_kind <> 'purchase' then
    raise exception 'Nákupní cenu lze zapsat jen do nákupního ceníku.' using errcode = 'P0001';
  end if;
  if tg_table_name <> 'purchase_price_entries' and v_kind = 'purchase' then
    raise exception 'Do nákupního ceníku nelze zapsat prodejní cenu ani doplatek.' using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger price_list_entries_kind_check before insert or update on price_list_entries for each row execute function price_version_rows_kind_check();
create trigger price_list_surcharges_kind_check before insert or update on price_list_surcharges for each row execute function price_version_rows_kind_check();
create trigger purchase_price_entries_kind_check before insert or update on purchase_price_entries for each row execute function price_version_rows_kind_check();

create table purchase_price_list_companies (
  id uuid primary key default gen_random_uuid(),
  price_list_id uuid not null references versioned_price_lists (id) on delete restrict,
  realization_company_id text not null references print_surface_realization_companies (id) on delete restrict,
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table purchase_price_list_companies is 'Realization firms buying by a purchase list. MVP: one active purchase list per firm (one shared list for Creativ Expo, Gendai and MAC Praha). A future contract exception = its own purchase list linked to that one firm.';

create unique index purchase_price_list_companies_active_key on purchase_price_list_companies (realization_company_id) where is_active;
create unique index purchase_price_list_companies_pair_key on purchase_price_list_companies (price_list_id, realization_company_id);

create trigger purchase_price_list_companies_set_updated_at before update on purchase_price_list_companies for each row execute function set_updated_at();

create or replace function purchase_price_list_companies_validate() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Vazbu firmy na nákupní ceník nelze smazat, lze ji jen deaktivovat.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from versioned_price_lists where id = new.price_list_id and kind = 'purchase') then
    raise exception 'Realizační firmu lze přiřadit jen k nákupnímu ceníku.' using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger purchase_price_list_companies_validate before insert or update or delete on purchase_price_list_companies for each row execute function purchase_price_list_companies_validate();

-- =========================================================================
-- 6. Event -> version assignments (explicit, with history)
-- =========================================================================
create table event_price_assignments (
  id uuid primary key default gen_random_uuid(),
  event_id text not null references events (id) on delete restrict,
  list_kind text not null check (list_kind in ('base', 'electricity')),
  price_list_version_id uuid not null references price_list_versions (id) on delete restrict,
  assigned_at timestamptz not null default now(),
  assigned_by text,
  note text,
  replaced_at timestamptz,
  replaced_by text
);

comment on table event_price_assignments is 'Price list VERSION an event uses (base and electricity separately). Current row = replaced_at is null. Re-assignment closes the current row and opens a new one (history kept). Publishing a new version never changes an assignment; the event date never selects a version.';

create unique index event_price_assignments_current_key on event_price_assignments (event_id, list_kind) where replaced_at is null;
create index event_price_assignments_version_idx on event_price_assignments (price_list_version_id);

create or replace function event_price_assignments_guard() returns trigger as $$
declare
  v_status text;
  v_kind text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Historii přiřazení ceníku nelze mazat.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    if old.replaced_at is not null
      or (to_jsonb(new) - array['replaced_at', 'replaced_by']) <> (to_jsonb(old) - array['replaced_at', 'replaced_by'])
      or new.replaced_at is null then
      raise exception 'Přiřazení ceníku lze jen ukončit novým přiřazením.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  select version.status, list.kind into v_status, v_kind
  from price_list_versions version join versioned_price_lists list on list.id = version.price_list_id
  where version.id = new.price_list_version_id;
  if v_status is distinct from 'published' then
    raise exception 'Veletrhu lze přiřadit jen publikovanou verzi ceníku.' using errcode = 'P0001';
  end if;
  if v_kind is distinct from new.list_kind then
    raise exception 'Druh ceníku neodpovídá přiřazení (základní / elektřina).' using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger event_price_assignments_guard before insert or update or delete on event_price_assignments for each row execute function event_price_assignments_guard();

-- =========================================================================
-- 7. RPC: new version (empty or copy), save draft rows, publish, assign
-- =========================================================================
-- New draft version of a list; with p_based_on it copies the header (rate, rounding, validity,
-- label) and every row of that version — the "opravná verze" of a published version.
create or replace function create_price_list_version(p_price_list_id uuid, p_based_on uuid, p_actor text)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
  v_no integer;
  v_source price_list_versions%rowtype;
begin
  perform 1 from versioned_price_lists where id = p_price_list_id for update;
  if not found then
    raise exception 'Ceník nebyl nalezen.' using errcode = 'P0002';
  end if;
  select coalesce(max(version_no), 0) + 1 into v_no from price_list_versions where price_list_id = p_price_list_id;
  if p_based_on is not null then
    select * into v_source from price_list_versions where id = p_based_on;
    if not found or v_source.price_list_id <> p_price_list_id then
      raise exception 'Zdrojová verze nepatří do tohoto ceníku.' using errcode = 'P0001';
    end if;
    insert into price_list_versions (price_list_id, version_no, label, valid_from, valid_to, eur_rate, eur_rounding_mode, eur_rounding_step, based_on_version_id, created_by)
    values (p_price_list_id, v_no, v_source.label, v_source.valid_from, v_source.valid_to, v_source.eur_rate, v_source.eur_rounding_mode, v_source.eur_rounding_step, p_based_on, p_actor)
    returning id into v_id;
    insert into price_list_entries (version_id, catalog_item_id, variant_id, price_mode, sale_czk, eur_mode, sale_eur, unit_code, note)
    select v_id, catalog_item_id, variant_id, price_mode, sale_czk, eur_mode, sale_eur, unit_code, note from price_list_entries where version_id = p_based_on;
    insert into price_list_surcharges (version_id, target_kind, variant_id, kit_item_id, line_key, substitute_item_id, substitute_variant_id, amount_czk, eur_mode, amount_eur, note)
    select v_id, target_kind, variant_id, kit_item_id, line_key, substitute_item_id, substitute_variant_id, amount_czk, eur_mode, amount_eur, note from price_list_surcharges where version_id = p_based_on;
    insert into purchase_price_entries (version_id, catalog_item_id, variant_id, purchase_czk, unit_code, note)
    select v_id, catalog_item_id, variant_id, purchase_czk, unit_code, note from purchase_price_entries where version_id = p_based_on;
  else
    insert into price_list_versions (price_list_id, version_no, created_by) values (p_price_list_id, v_no, p_actor) returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- Publish a draft. The domain shows the same checks first (domain/priceVersions.ts
-- validateVersionForPublish); these are the safety net.
create or replace function publish_price_list_version(p_version_id uuid, p_actor text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version price_list_versions%rowtype;
  v_kind text;
  v_rows integer;
begin
  select * into v_version from price_list_versions where id = p_version_id for update;
  if not found then
    raise exception 'Verze ceníku nebyla nalezena.' using errcode = 'P0002';
  end if;
  if v_version.status <> 'draft' then
    raise exception 'Publikovat lze jen koncept.' using errcode = 'P0001';
  end if;
  select kind into v_kind from versioned_price_lists where id = v_version.price_list_id;
  if v_kind = 'purchase' then
    select count(*) into v_rows from purchase_price_entries where version_id = p_version_id;
  else
    select count(*) into v_rows from price_list_entries where version_id = p_version_id;
  end if;
  if v_rows = 0 then
    raise exception 'Prázdnou verzi ceníku nelze publikovat.' using errcode = 'P0001';
  end if;
  if v_kind = 'electricity' and exists (
    select 1 from price_list_entries entry join catalog_items item on item.id = entry.catalog_item_id
    where entry.version_id = p_version_id and item.price_category <> 'electricity'
  ) then
    raise exception 'Ceník elektřiny smí obsahovat jen položky kategorie Elektřina.' using errcode = 'P0001';
  end if;
  perform set_config('app.publish_price_list_version', p_version_id::text, true);
  update price_list_versions set status = 'published', published_at = now(), published_by = p_actor where id = p_version_id;
  perform set_config('app.publish_price_list_version', '', true);
end;
$$;

-- Assign (or with p_version_id null, unassign) the current base / electricity version of an event.
create or replace function assign_event_price_version(p_event_id text, p_list_kind text, p_version_id uuid, p_actor text, p_note text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform 1 from events where id = p_event_id for update;
  if not found then
    raise exception 'Veletrh nebyl nalezen.' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from event_price_assignments
    where event_id = p_event_id and list_kind = p_list_kind and replaced_at is null and price_list_version_id is not distinct from p_version_id
  ) then
    return;
  end if;
  update event_price_assignments set replaced_at = now(), replaced_by = p_actor
  where event_id = p_event_id and list_kind = p_list_kind and replaced_at is null;
  if p_version_id is not null then
    insert into event_price_assignments (event_id, list_kind, price_list_version_id, assigned_by, note)
    values (p_event_id, p_list_kind, p_version_id, p_actor, nullif(btrim(coalesce(p_note, '')), ''));
  end if;
end;
$$;

-- Replace all rows of a DRAFT sale version in one transaction (the row guards refuse anything else).
-- p_entries: [{catalog_item_id, variant_id, price_mode, sale_czk, eur_mode, sale_eur, unit_code, note}]
-- p_surcharges: [{target_kind, variant_id, kit_item_id, line_key, substitute_item_id, substitute_variant_id, amount_czk, eur_mode, amount_eur, note}]
create or replace function replace_sale_price_version_rows(p_version_id uuid, p_entries jsonb, p_surcharges jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if jsonb_typeof(p_entries) <> 'array' or jsonb_typeof(p_surcharges) <> 'array' then
    raise exception 'Řádky ceníku musí být pole.' using errcode = '22023';
  end if;
  perform 1 from price_list_versions where id = p_version_id and status = 'draft' for update;
  if not found then
    raise exception 'Upravit lze jen koncept verze ceníku.' using errcode = 'P0001';
  end if;
  delete from price_list_entries where version_id = p_version_id;
  delete from price_list_surcharges where version_id = p_version_id;
  insert into price_list_entries (version_id, catalog_item_id, variant_id, price_mode, sale_czk, eur_mode, sale_eur, unit_code, note)
  select p_version_id,
    (row.value ->> 'catalog_item_id')::uuid,
    nullif(row.value ->> 'variant_id', '')::uuid,
    coalesce(row.value ->> 'price_mode', 'fixed'),
    (row.value ->> 'sale_czk')::numeric,
    coalesce(row.value ->> 'eur_mode', 'derived'),
    (row.value ->> 'sale_eur')::numeric,
    nullif(row.value ->> 'unit_code', ''),
    nullif(row.value ->> 'note', '')
  from jsonb_array_elements(p_entries) as row(value);
  insert into price_list_surcharges (version_id, target_kind, variant_id, kit_item_id, line_key, substitute_item_id, substitute_variant_id, amount_czk, eur_mode, amount_eur, note)
  select p_version_id,
    row.value ->> 'target_kind',
    nullif(row.value ->> 'variant_id', '')::uuid,
    nullif(row.value ->> 'kit_item_id', '')::uuid,
    nullif(row.value ->> 'line_key', ''),
    nullif(row.value ->> 'substitute_item_id', '')::uuid,
    nullif(row.value ->> 'substitute_variant_id', '')::uuid,
    (row.value ->> 'amount_czk')::numeric,
    coalesce(row.value ->> 'eur_mode', 'derived'),
    (row.value ->> 'amount_eur')::numeric,
    nullif(row.value ->> 'note', '')
  from jsonb_array_elements(p_surcharges) as row(value);
end;
$$;

-- Same for a DRAFT purchase version. p_entries: [{catalog_item_id, variant_id, purchase_czk, unit_code, note}]
create or replace function replace_purchase_price_version_rows(p_version_id uuid, p_entries jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if jsonb_typeof(p_entries) <> 'array' then
    raise exception 'Řádky ceníku musí být pole.' using errcode = '22023';
  end if;
  perform 1 from price_list_versions where id = p_version_id and status = 'draft' for update;
  if not found then
    raise exception 'Upravit lze jen koncept verze ceníku.' using errcode = 'P0001';
  end if;
  delete from purchase_price_entries where version_id = p_version_id;
  insert into purchase_price_entries (version_id, catalog_item_id, variant_id, purchase_czk, unit_code, note)
  select p_version_id,
    (row.value ->> 'catalog_item_id')::uuid,
    nullif(row.value ->> 'variant_id', '')::uuid,
    (row.value ->> 'purchase_czk')::numeric,
    nullif(row.value ->> 'unit_code', ''),
    nullif(row.value ->> 'note', '')
  from jsonb_array_elements(p_entries) as row(value);
end;
$$;

revoke all on function replace_sale_price_version_rows(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function replace_purchase_price_version_rows(uuid, jsonb) from public, anon, authenticated;
grant execute on function replace_sale_price_version_rows(uuid, jsonb, jsonb) to service_role;
grant execute on function replace_purchase_price_version_rows(uuid, jsonb) to service_role;

revoke all on function create_price_list_version(uuid, uuid, text) from public, anon, authenticated;
revoke all on function publish_price_list_version(uuid, text) from public, anon, authenticated;
revoke all on function assign_event_price_version(text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function create_price_list_version(uuid, uuid, text) to service_role;
grant execute on function publish_price_list_version(uuid, text) to service_role;
grant execute on function assign_event_price_version(text, text, uuid, text, text) to service_role;

-- Browser must never talk to Postgres directly — RLS with zero policies, like every table.
alter table versioned_price_lists enable row level security;
alter table price_list_versions enable row level security;
alter table price_list_entries enable row level security;
alter table price_list_surcharges enable row level security;
alter table purchase_price_entries enable row level security;
alter table purchase_price_list_companies enable row level security;
alter table event_price_assignments enable row level security;
