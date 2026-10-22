-- V1-DATA-05 correction — three sale prices per row (docs/V1_DATA_DECISIONS.md section 8.1).
--
-- Every sale row of a version carries THREE prices at once:
--   CZK        sale_czk                      fixed price in CZK
--   EUR_SK     derived from sale_czk by the version rate and rounding (eur_mode = derived), or
--              overridden by hand and recorded as such (eur_mode = manual, value in sale_eur)
--   EUR_WORLD  sale_eur_world                its own fixed EUR price, no link to the rate
-- A future offer / project chooses one of them explicitly (never by the customer's country).
--
-- Additive and safe for existing data: two nullable columns, no row is updated (published versions
-- stay byte-for-byte as they were). Rows written before this migration with eur_mode = 'direct'
-- are read as EUR_WORLD = sale_eur and EUR_SK = derived from CZK (domain/priceVersions.ts); new
-- writes never use 'direct' or 'none'. Functions are replaced in place to save / copy / check the
-- new columns.

alter table price_list_entries add column sale_eur_world numeric(12, 2);
alter table price_list_entries add constraint price_list_entries_eur_world_check check (sale_eur_world is null or sale_eur_world >= 0);
alter table price_list_entries add constraint price_list_entries_eur_world_only_fixed check (price_mode = 'fixed' or sale_eur_world is null);

comment on column price_list_entries.sale_czk is 'CZK sale price without VAT.';
comment on column price_list_entries.eur_mode is 'EUR_SK price: derived = sale_czk / version eur_rate rounded by the version rule; manual = derived price overridden by hand (sale_eur, recorded as manual). Legacy rows only: direct (sale_eur read as EUR_WORLD, EUR_SK derived) and none.';
comment on column price_list_entries.sale_eur is 'Manual EUR_SK price (eur_mode = manual). Legacy direct rows: the EUR price, read as EUR_WORLD.';
comment on column price_list_entries.sale_eur_world is 'EUR_WORLD sale price without VAT: fixed in EUR, independent of the CZK price and the rate. Required for publishing a fixed row.';

alter table price_list_surcharges add column amount_eur_world numeric(12, 2);
alter table price_list_surcharges add constraint price_list_surcharges_eur_world_check check (amount_eur_world is null or amount_eur_world >= 0);

comment on column price_list_surcharges.amount_eur_world is 'EUR_WORLD surcharge amount (fixed in EUR). amount_czk / eur_mode / amount_eur are CZK and EUR_SK, same rules as price_list_entries.';

-- Draft save now also writes the EUR_WORLD columns.
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
  insert into price_list_entries (version_id, catalog_item_id, variant_id, price_mode, sale_czk, eur_mode, sale_eur, sale_eur_world, unit_code, note)
  select p_version_id,
    (row.value ->> 'catalog_item_id')::uuid,
    nullif(row.value ->> 'variant_id', '')::uuid,
    coalesce(row.value ->> 'price_mode', 'fixed'),
    (row.value ->> 'sale_czk')::numeric,
    coalesce(row.value ->> 'eur_mode', 'derived'),
    (row.value ->> 'sale_eur')::numeric,
    (row.value ->> 'sale_eur_world')::numeric,
    nullif(row.value ->> 'unit_code', ''),
    nullif(row.value ->> 'note', '')
  from jsonb_array_elements(p_entries) as row(value);
  insert into price_list_surcharges (version_id, target_kind, variant_id, kit_item_id, line_key, substitute_item_id, substitute_variant_id, amount_czk, eur_mode, amount_eur, amount_eur_world, note)
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
    (row.value ->> 'amount_eur_world')::numeric,
    nullif(row.value ->> 'note', '')
  from jsonb_array_elements(p_surcharges) as row(value);
end;
$$;

-- A new version copies the EUR_WORLD columns too.
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
    -- Legacy direct rows become the current shape in the copy: EUR price -> EUR_WORLD, EUR_SK derived.
    insert into price_list_entries (version_id, catalog_item_id, variant_id, price_mode, sale_czk, eur_mode, sale_eur, sale_eur_world, unit_code, note)
    select v_id, catalog_item_id, variant_id, price_mode, sale_czk,
      case when price_mode = 'fixed' and eur_mode = 'direct' and sale_czk is not null then 'derived' else eur_mode end,
      case when price_mode = 'fixed' and eur_mode = 'direct' and sale_czk is not null then null else sale_eur end,
      coalesce(sale_eur_world, case when eur_mode = 'direct' then sale_eur end),
      unit_code, note
    from price_list_entries where version_id = p_based_on;
    insert into price_list_surcharges (version_id, target_kind, variant_id, kit_item_id, line_key, substitute_item_id, substitute_variant_id, amount_czk, eur_mode, amount_eur, amount_eur_world, note)
    select v_id, target_kind, variant_id, kit_item_id, line_key, substitute_item_id, substitute_variant_id, amount_czk,
      case when eur_mode = 'direct' and amount_czk is not null then 'derived' else eur_mode end,
      case when eur_mode = 'direct' and amount_czk is not null then null else amount_eur end,
      coalesce(amount_eur_world, case when eur_mode = 'direct' then amount_eur end),
      note
    from price_list_surcharges where version_id = p_based_on;
    insert into purchase_price_entries (version_id, catalog_item_id, variant_id, purchase_czk, unit_code, note)
    select v_id, catalog_item_id, variant_id, purchase_czk, unit_code, note from purchase_price_entries where version_id = p_based_on;
  else
    insert into price_list_versions (price_list_id, version_no, created_by) values (p_price_list_id, v_no, p_actor) returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- Publishing a sale version now needs all three prices of every fixed row and surcharge.
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
  if v_kind <> 'purchase' and exists (
    select 1 from price_list_entries
    where version_id = p_version_id and price_mode = 'fixed'
      and (sale_czk is null or sale_eur_world is null or eur_mode not in ('derived', 'manual'))
  ) then
    raise exception 'Každá položka s pevnou cenou musí mít cenu CZK, EUR_SK (přepočet nebo ruční) a EUR_WORLD.' using errcode = 'P0001';
  end if;
  if v_kind <> 'purchase' and exists (
    select 1 from price_list_surcharges
    where version_id = p_version_id and (amount_czk is null or amount_eur_world is null or eur_mode not in ('derived', 'manual'))
  ) then
    raise exception 'Každý doplatek musí mít částku CZK, EUR_SK a EUR_WORLD.' using errcode = 'P0001';
  end if;
  perform set_config('app.publish_price_list_version', p_version_id::text, true);
  update price_list_versions set status = 'published', published_at = now(), published_by = p_actor where id = p_version_id;
  perform set_config('app.publish_price_list_version', '', true);
end;
$$;

revoke all on function replace_sale_price_version_rows(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function create_price_list_version(uuid, uuid, text) from public, anon, authenticated;
revoke all on function publish_price_list_version(uuid, text) from public, anon, authenticated;
grant execute on function replace_sale_price_version_rows(uuid, jsonb, jsonb) to service_role;
grant execute on function create_price_list_version(uuid, uuid, text) to service_role;
grant execute on function publish_price_list_version(uuid, text) to service_role;
