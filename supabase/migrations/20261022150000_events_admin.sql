-- V1-DATA-06 — event administration (docs/V1_DATA_DECISIONS.md section 9).
--
-- Additive: no existing event row, document or legacy field is rewritten.
--   1. events.short_code — optional, unique, stable short code (e.g. BEAUTY-2026-P). Kept separate
--      from the display name and from any folder on disk. Once set it cannot be changed or cleared
--      by a plain UPDATE (a controlled change procedure is future work). Never back-filled.
--   2. events cannot be deleted — deactivate instead (several tables cascade on event delete).
--   3. event_realization_companies — firms of the real register (V1-DATA-02) per role
--      (construction / graphics / electrical / other); several per role, at most one active default
--      per role. The default is a suggestion only. The legacy events.document.realizationCompanyId
--      ('default', 'realization-2..4') stays untouched for the old price calculations.
--   4. event_path_mappings — configured folder per role on P: / UNC (Organizer spec section 1,
--      EventPathMapping). Metadata only: the web app never touches the file system.
--   5. events.config_revision — optimistic concurrency of (3) and (4), independent of the event
--      document revision, so saving a section never conflicts with saving the card document.

-- =========================================================================
-- 1. Short code
-- =========================================================================
alter table events add column short_code text;
alter table events add constraint events_short_code_format check (short_code is null or (short_code ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' and length(short_code) <= 32));
create unique index events_short_code_key on events (short_code) where short_code is not null;

comment on column events.short_code is 'Optional stable short code of the event (e.g. BEAUTY-2026-P) for folder names and future job numbers. Separate from name and disk paths. Immutable once set (trigger); not back-filled for existing events.';

create or replace function events_short_code_guard() returns trigger as $$
begin
  if old.short_code is not null and new.short_code is distinct from old.short_code
    and coalesce(current_setting('app.event_short_code_change', true), '') <> old.id then
    raise exception 'Kód veletrhu % je po uložení neměnný. Změna je možná jen řízeným postupem.', old.short_code using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger events_short_code_guard before update on events for each row execute function events_short_code_guard();

-- =========================================================================
-- 2. No physical delete of events
-- =========================================================================
create or replace function events_prevent_delete() returns trigger as $$
begin
  raise exception 'Veletrh % nelze smazat, lze jej jen deaktivovat.', old.id using errcode = 'P0001';
end;
$$ language plpgsql;

create trigger events_prevent_delete before delete on events for each row execute function events_prevent_delete();

-- =========================================================================
-- 3. Realization companies of an event
-- =========================================================================
alter table events add column config_revision integer not null default 1 check (config_revision > 0);

comment on column events.config_revision is 'Optimistic concurrency counter of the event configuration sections (event_realization_companies, event_path_mappings). Independent of events.revision (the card document).';

create table event_realization_companies (
  id uuid primary key default gen_random_uuid(),
  event_id text not null references events (id) on delete restrict,
  realization_company_id text not null references print_surface_realization_companies (id) on delete restrict,
  role text not null check (role in ('construction', 'graphics', 'electrical', 'other')),
  is_default boolean not null default false,
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_realization_companies_key unique (event_id, realization_company_id, role)
);

comment on table event_realization_companies is 'Realization firms of an event by role (stavba, grafika/tisk, elektro, ostatní). Several per role; is_default = suggested firm of the role (at most one active). Removed links are deactivated, never deleted. Does not replace the legacy events.document.realizationCompanyId.';

create unique index event_realization_companies_default_key on event_realization_companies (event_id, role) where is_default and is_active;
create index event_realization_companies_company_idx on event_realization_companies (realization_company_id);

create trigger event_realization_companies_set_updated_at before update on event_realization_companies for each row execute function set_updated_at();

create or replace function event_realization_companies_prevent_delete() returns trigger as $$
begin
  raise exception 'Přiřazení realizační firmy k veletrhu nelze smazat, lze je jen deaktivovat.' using errcode = 'P0001';
end;
$$ language plpgsql;

create trigger event_realization_companies_prevent_delete before delete on event_realization_companies for each row execute function event_realization_companies_prevent_delete();

-- =========================================================================
-- 4. Folder paths of an event (configuration, metadata only)
-- =========================================================================
create table event_path_mappings (
  id uuid primary key default gen_random_uuid(),
  event_id text not null references events (id) on delete restrict,
  role text not null check (role in ('event_root', 'documents', 'working_stands', 'event_graphics', 'contractor_outputs', 'technical_rasters', 'event_carpet', 'abra_imports', 'issued_orders', 'settlements')),
  configured_path text not null check (btrim(configured_path) <> '' and length(configured_path) <= 1024 and position('..' in configured_path) = 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_path_mappings_key unique (event_id, role)
);

comment on table event_path_mappings is 'Configured folder of an event per role (Organizer spec section 1). Absolute (P:\...), UNC (\\server\share\...) or relative to event_root. Metadata only — the web app never reads or writes the file system; existing folder names are kept as they are.';

create trigger event_path_mappings_set_updated_at before update on event_path_mappings for each row execute function set_updated_at();

-- =========================================================================
-- 5. Section saves (transactional, revision-checked)
-- =========================================================================
create or replace function event_config_lock(p_event_id text, p_expected_config_revision integer) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_revision integer;
begin
  select config_revision into v_revision from events where id = p_event_id for update;
  if not found then
    raise exception 'Veletrh nebyl nalezen. Nejdřív kartu veletrhu uložte.' using errcode = 'P0002';
  end if;
  if p_expected_config_revision is null or v_revision <> p_expected_config_revision then
    raise exception 'Nastavení veletrhu mezitím změnil někdo jiný. Nic nebylo uloženo; načtěte aktuální stav.'
      using errcode = 'P0409', detail = 'current_revision=' || v_revision;
  end if;
  update events set config_revision = config_revision + 1 where id = p_event_id;
  return v_revision + 1;
end;
$$;

-- p_links: [{realization_company_id, role, is_default, note}] = the full ACTIVE set. Links missing from
-- it are deactivated (kept as history); a link sent again is reactivated.
create or replace function save_event_realization_companies(p_event_id text, p_expected_config_revision integer, p_links jsonb) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_revision integer;
begin
  if jsonb_typeof(p_links) <> 'array' then
    raise exception 'Přiřazení firem musí být pole.' using errcode = '22023';
  end if;
  v_revision := event_config_lock(p_event_id, p_expected_config_revision);
  update event_realization_companies set is_active = false, is_default = false
  where event_id = p_event_id and is_active
    and (realization_company_id, role) not in (
      select link.value ->> 'realization_company_id', link.value ->> 'role' from jsonb_array_elements(p_links) as link(value)
    );
  -- Clear defaults first so the partial unique index never sees two at once.
  update event_realization_companies set is_default = false where event_id = p_event_id and is_default;
  insert into event_realization_companies (event_id, realization_company_id, role, is_default, is_active, note)
  select p_event_id, link.value ->> 'realization_company_id', link.value ->> 'role', coalesce((link.value ->> 'is_default')::boolean, false), true, nullif(btrim(coalesce(link.value ->> 'note', '')), '')
  from jsonb_array_elements(p_links) as link(value)
  on conflict (event_id, realization_company_id, role) do update set
    is_default = excluded.is_default,
    is_active = true,
    note = excluded.note;
  return v_revision;
end;
$$;

-- p_paths: [{role, configured_path, note}] = the full set; roles missing from it are removed.
create or replace function save_event_path_mappings(p_event_id text, p_expected_config_revision integer, p_paths jsonb) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_revision integer;
begin
  if jsonb_typeof(p_paths) <> 'array' then
    raise exception 'Cesty musí být pole.' using errcode = '22023';
  end if;
  v_revision := event_config_lock(p_event_id, p_expected_config_revision);
  delete from event_path_mappings
  where event_id = p_event_id and role not in (select path.value ->> 'role' from jsonb_array_elements(p_paths) as path(value));
  insert into event_path_mappings (event_id, role, configured_path, note)
  select p_event_id, path.value ->> 'role', path.value ->> 'configured_path', nullif(btrim(coalesce(path.value ->> 'note', '')), '')
  from jsonb_array_elements(p_paths) as path(value)
  on conflict (event_id, role) do update set configured_path = excluded.configured_path, note = excluded.note;
  return v_revision;
end;
$$;

revoke all on function event_config_lock(text, integer) from public, anon, authenticated;
revoke all on function save_event_realization_companies(text, integer, jsonb) from public, anon, authenticated;
revoke all on function save_event_path_mappings(text, integer, jsonb) from public, anon, authenticated;
grant execute on function event_config_lock(text, integer) to service_role;
grant execute on function save_event_realization_companies(text, integer, jsonb) to service_role;
grant execute on function save_event_path_mappings(text, integer, jsonb) to service_role;

alter table event_realization_companies enable row level security;
alter table event_path_mappings enable row level security;
