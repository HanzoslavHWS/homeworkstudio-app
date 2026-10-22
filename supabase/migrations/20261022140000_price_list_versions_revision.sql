-- V1-DATA-05 — optimistic concurrency for price list versions (docs/V1_DATA_DECISIONS.md 8.2).
--
-- Two people (or a person and a script) editing the same draft must never silently overwrite each
-- other. Every version gets a revision; every write that changes a version — its header, its whole
-- content, deletion, publishing, archiving, and copying a DRAFT into a new version — states the
-- revision it was based on. A mismatch is refused with SQLSTATE P0409 and nothing is written.
--
-- Additive for data: one column with default 1, no row of any price table is updated. The old
-- function signatures without a revision are dropped (functions only, no data), so no caller can
-- bypass the check.

alter table price_list_versions add column revision integer not null default 1 check (revision > 0);

comment on column price_list_versions.revision is 'Optimistic concurrency counter. Raised by every change of the version or its rows; writers pass the revision they saw and are refused (P0409) when it moved.';

-- Any direct update of a version row raises the revision (header save, archive, publish).
create or replace function price_list_versions_bump_revision() returns trigger as $$
begin
  if new.revision = old.revision then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger price_list_versions_bump_revision before update on price_list_versions for each row execute function price_list_versions_bump_revision();

-- The immutability guard now ignores the revision counter when it checks published -> archived.
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
    and (to_jsonb(new) - array['status', 'archived_at', 'updated_at', 'revision']) = (to_jsonb(old) - array['status', 'archived_at', 'updated_at', 'revision']) then
    return new;
  end if;
  raise exception 'Publikovaná verze ceníku je neměnná. Pro opravu vytvořte novou verzi.' using errcode = 'P0001';
end;
$$ language plpgsql;

-- Locks the version and checks the expected revision. Returns the locked row.
create or replace function price_list_version_lock(p_version_id uuid, p_expected_revision integer)
returns price_list_versions
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version price_list_versions%rowtype;
begin
  select * into v_version from price_list_versions where id = p_version_id for update;
  if not found then
    raise exception 'Verze ceníku nebyla nalezena.' using errcode = 'P0002';
  end if;
  if p_expected_revision is null or v_version.revision <> p_expected_revision then
    raise exception 'Verzi ceníku mezitím změnil někdo jiný (máte revizi %, aktuální je %). Nic nebylo uloženo; načtěte aktuální stav.', coalesce(p_expected_revision::text, '?'), v_version.revision
      using errcode = 'P0409', detail = 'current_revision=' || v_version.revision;
  end if;
  return v_version;
end;
$$;

-- =========================================================================
-- Whole draft content (sale / purchase): replace + raise revision, in one transaction.
-- =========================================================================
drop function if exists replace_sale_price_version_rows(uuid, jsonb, jsonb);
drop function if exists replace_purchase_price_version_rows(uuid, jsonb);

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
  update price_list_versions set revision = revision + 1 where id = p_version_id returning revision into v_version.revision;
  return v_version.revision;
end;
$$;

create or replace function replace_purchase_price_version_rows(p_version_id uuid, p_expected_revision integer, p_entries jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version price_list_versions%rowtype;
begin
  if jsonb_typeof(p_entries) <> 'array' then
    raise exception 'Řádky ceníku musí být pole.' using errcode = '22023';
  end if;
  v_version := price_list_version_lock(p_version_id, p_expected_revision);
  if v_version.status <> 'draft' then
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
  update price_list_versions set revision = revision + 1 where id = p_version_id returning revision into v_version.revision;
  return v_version.revision;
end;
$$;

-- =========================================================================
-- Header, delete, archive: conditional on the revision.
-- =========================================================================
create or replace function update_price_list_version_header(p_version_id uuid, p_expected_revision integer, p_header jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version price_list_versions%rowtype;
begin
  v_version := price_list_version_lock(p_version_id, p_expected_revision);
  if v_version.status <> 'draft' then
    raise exception 'Publikovaná verze ceníku je neměnná. Pro opravu vytvořte novou verzi.' using errcode = 'P0001';
  end if;
  update price_list_versions set
    label = nullif(p_header ->> 'label', ''),
    valid_from = nullif(p_header ->> 'valid_from', '')::date,
    valid_to = nullif(p_header ->> 'valid_to', '')::date,
    eur_rate = (p_header ->> 'eur_rate')::numeric,
    eur_rounding_mode = p_header ->> 'eur_rounding_mode',
    eur_rounding_step = (p_header ->> 'eur_rounding_step')::numeric,
    note = nullif(p_header ->> 'note', '')
  where id = p_version_id
  returning revision into v_version.revision;
  return v_version.revision;
end;
$$;

create or replace function delete_price_list_version_draft(p_version_id uuid, p_expected_revision integer)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version price_list_versions%rowtype;
begin
  v_version := price_list_version_lock(p_version_id, p_expected_revision);
  if v_version.status <> 'draft' then
    raise exception 'Smazat lze jen koncept. Publikovanou verzi lze archivovat.' using errcode = 'P0001';
  end if;
  delete from price_list_versions where id = p_version_id;
end;
$$;

create or replace function archive_price_list_version(p_version_id uuid, p_expected_revision integer)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version price_list_versions%rowtype;
begin
  v_version := price_list_version_lock(p_version_id, p_expected_revision);
  if v_version.status <> 'published' then
    raise exception 'Archivovat lze jen publikovanou verzi.' using errcode = 'P0001';
  end if;
  update price_list_versions set status = 'archived', archived_at = now() where id = p_version_id returning revision into v_version.revision;
  return v_version.revision;
end;
$$;

-- =========================================================================
-- Publish: same checks as before, now against the expected revision.
-- =========================================================================
drop function if exists publish_price_list_version(uuid, text);

create or replace function publish_price_list_version(p_version_id uuid, p_expected_revision integer, p_actor text)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version price_list_versions%rowtype;
  v_kind text;
  v_rows integer;
begin
  v_version := price_list_version_lock(p_version_id, p_expected_revision);
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
  update price_list_versions set status = 'published', published_at = now(), published_by = p_actor where id = p_version_id returning revision into v_version.revision;
  perform set_config('app.publish_price_list_version', '', true);
  return v_version.revision;
end;
$$;

-- =========================================================================
-- Copy: a DRAFT source must be at the revision the user saw (a published one cannot change).
-- =========================================================================
drop function if exists create_price_list_version(uuid, uuid, text);

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

-- =========================================================================
-- Event assignment: the caller states which version it saw as current (null = none).
-- =========================================================================
drop function if exists assign_event_price_version(text, text, uuid, text, text);

create or replace function assign_event_price_version(p_event_id text, p_list_kind text, p_version_id uuid, p_expected_current_version_id uuid, p_actor text, p_note text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current uuid;
begin
  perform 1 from events where id = p_event_id for update;
  if not found then
    raise exception 'Veletrh nebyl nalezen.' using errcode = 'P0002';
  end if;
  select price_list_version_id into v_current from event_price_assignments
  where event_id = p_event_id and list_kind = p_list_kind and replaced_at is null;
  if v_current is distinct from p_expected_current_version_id then
    raise exception 'Přiřazení ceníku veletrhu mezitím změnil někdo jiný. Nic nebylo uloženo; načtěte aktuální stav.' using errcode = 'P0409';
  end if;
  if v_current is not distinct from p_version_id then
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

revoke all on function price_list_version_lock(uuid, integer) from public, anon, authenticated;
revoke all on function replace_sale_price_version_rows(uuid, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function replace_purchase_price_version_rows(uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function update_price_list_version_header(uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function delete_price_list_version_draft(uuid, integer) from public, anon, authenticated;
revoke all on function archive_price_list_version(uuid, integer) from public, anon, authenticated;
revoke all on function publish_price_list_version(uuid, integer, text) from public, anon, authenticated;
revoke all on function create_price_list_version(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function assign_event_price_version(text, text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function price_list_version_lock(uuid, integer) to service_role;
grant execute on function replace_sale_price_version_rows(uuid, integer, jsonb, jsonb) to service_role;
grant execute on function replace_purchase_price_version_rows(uuid, integer, jsonb) to service_role;
grant execute on function update_price_list_version_header(uuid, integer, jsonb) to service_role;
grant execute on function delete_price_list_version_draft(uuid, integer) to service_role;
grant execute on function archive_price_list_version(uuid, integer) to service_role;
grant execute on function publish_price_list_version(uuid, integer, text) to service_role;
grant execute on function create_price_list_version(uuid, uuid, integer, text) to service_role;
grant execute on function assign_event_price_version(text, text, uuid, uuid, text, text) to service_role;
