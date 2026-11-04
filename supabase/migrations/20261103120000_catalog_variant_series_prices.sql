-- V1-CARPET-02/03: product line (série) of a swatch-book variant, its image metadata, and sale
-- prices per product line.
--
-- Non-destructive: only new nullable columns, one replaced unique index (same rows stay unique —
-- the new key only adds variant_series) and two functions recreated with the extra column. No
-- existing row, variant, price list or version is rewritten.
--
--   catalog_variants.series        e.g. PODIUM-PLAT / REVEXPO (one swatch book, several lines)
--   catalog_variants.photo_asset   catalog swatch photo (StoredAsset in R2), optional
--   catalog_variants.texture_asset repeatable 3D floor texture (StoredAsset), optional — a photo
--                                  is NOT automatically a texture
--   catalog_variants.image_source  where the supplier image is and whether we may copy it:
--                                  {sourcePageUrl, sourceImageUrl, status: pending_permission |
--                                  approved | rejected, note?}
--   price_list_entries.variant_series  price of one product line of a card. Resolution order:
--                                  variant row -> product-line row -> card row. Keyed by the
--                                  card, so M02 + REVEXPO never prices M04 + REVEXPO.

alter table catalog_variants
  add column series text check (series is null or (series ~ '^[A-Z0-9][A-Z0-9_-]*$' and length(series) <= 64)),
  add column photo_asset jsonb check (photo_asset is null or jsonb_typeof(photo_asset) = 'object'),
  add column texture_asset jsonb check (texture_asset is null or jsonb_typeof(texture_asset) = 'object'),
  add column image_source jsonb check (image_source is null or jsonb_typeof(image_source) = 'object');

comment on column catalog_variants.series is 'Product line inside the swatch book (PODIUM-PLAT, REVEXPO). Prices may be set per line (price_list_entries.variant_series).';
comment on column catalog_variants.photo_asset is 'Catalog swatch photo (R2 StoredAsset). Only a photo we may use; never a placeholder.';
comment on column catalog_variants.texture_asset is 'Repeatable 3D floor texture (R2 StoredAsset). Absent = the 3D view uses swatch_color.';
comment on column catalog_variants.image_source is 'Supplier image provenance: {sourcePageUrl, sourceImageUrl, status pending_permission|approved|rejected, note}. Copying into R2 needs status approved.';

alter table price_list_entries
  add column variant_series text check (variant_series is null or (variant_series ~ '^[A-Z0-9][A-Z0-9_-]*$' and length(variant_series) <= 64)),
  add constraint price_list_entries_variant_or_series check (variant_id is null or variant_series is null);

comment on column price_list_entries.variant_series is 'Price of one product line (catalog_variants.series) of the card. Resolution: variant row -> product-line row -> card row.';

drop index price_list_entries_key;
create unique index price_list_entries_key on price_list_entries (
  version_id,
  catalog_item_id,
  coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(variant_series, '')
);

-- Same bodies as 20261022140000_price_list_versions_revision.sql, plus variant_series.
create or replace function replace_sale_price_version_rows(p_version_id uuid, p_expected_revision integer, p_entries jsonb, p_surcharges jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version price_list_versions%rowtype;
begin
  if jsonb_typeof(p_entries) <> 'array' or jsonb_typeof(p_surcharges) <> 'array' then
    raise exception 'Řádky ceníku musí být pole.' using errcode = '22023';
  end if;
  v_version := price_list_version_lock(p_version_id, p_expected_revision);
  if v_version.status <> 'draft' then
    raise exception 'Upravit lze jen koncept verze ceníku.' using errcode = 'P0001';
  end if;
  delete from price_list_entries where version_id = p_version_id;
  delete from price_list_surcharges where version_id = p_version_id;
  insert into price_list_entries (version_id, catalog_item_id, variant_id, variant_series, price_mode, sale_czk, eur_mode, sale_eur, sale_eur_world, unit_code, note)
  select p_version_id,
    (row.value ->> 'catalog_item_id')::uuid,
    nullif(row.value ->> 'variant_id', '')::uuid,
    nullif(row.value ->> 'variant_series', ''),
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
  update price_list_versions set revision = revision + 1 where id = p_version_id returning revision into v_version.revision;
  return v_version.revision;
end;
$$;

create or replace function create_price_list_version(p_price_list_id uuid, p_based_on uuid, p_expected_source_revision integer, p_actor text)
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
    v_source := price_list_version_lock(p_based_on, p_expected_source_revision);
    if v_source.price_list_id <> p_price_list_id then
      raise exception 'Zdrojová verze nepatří do tohoto ceníku.' using errcode = 'P0001';
    end if;
    insert into price_list_versions (price_list_id, version_no, label, valid_from, valid_to, eur_rate, eur_rounding_mode, eur_rounding_step, based_on_version_id, created_by)
    values (p_price_list_id, v_no, v_source.label, v_source.valid_from, v_source.valid_to, v_source.eur_rate, v_source.eur_rounding_mode, v_source.eur_rounding_step, p_based_on, p_actor)
    returning id into v_id;
    insert into price_list_entries (version_id, catalog_item_id, variant_id, variant_series, price_mode, sale_czk, eur_mode, sale_eur, sale_eur_world, unit_code, note)
    select v_id, catalog_item_id, variant_id, variant_series, price_mode, sale_czk,
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
