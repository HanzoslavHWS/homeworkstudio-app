-- V1-AUTH-02: shared HomeworkStudio accounts, application registry and per-application access.
--
-- One person = one account (app_users, id = auth.users.id, unchanged). Access to an application is
-- a membership (app_memberships, one row per account × application) with a role valid for that
-- application. app_users.is_hws_admin marks a SHARED administrator (accounts and access) — it opens
-- no application data. The former single role (app_users.role) becomes the ABF membership of every
-- existing account, with the same value; active / deactivated states, ids, passwords (Supabase Auth),
-- sessions, project assignments and history are untouched. Nobody becomes a shared administrator
-- here: the first one is named explicitly by the DEV bootstrap script (scripts/authBootstrapAdmin.ts).
--
-- Like the rest of this schema: RLS on, no policies, no grants for anon/authenticated — only the
-- authorized Next.js API (service role) reads and writes these rows.
-- Rollback (before this stage): supabase/rollback/20261110120000_hws_accounts_app_memberships.down.sql

-- ---------------------------------------------------------------------------------------------
-- Application registry
-- ---------------------------------------------------------------------------------------------
create table hws_apps (
  key text primary key check (key ~ '^[a-z][a-z0-9-]{1,39}$'),
  name text not null check (length(trim(name)) > 0),
  url text check (url is null or url ~ '^(/[A-Za-z0-9/_-]*|https://[^[:space:]]+)$'),
  status text not null check (status in ('available', 'coming_soon')),
  roles text[] not null check (cardinality(roles) > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- a "coming soon" application never opens an address; an available one always has one
  constraint hws_apps_url_matches_status check ((status = 'available') = (url is not null))
);
comment on table hws_apps is 'Registry of HomeworkStudio applications (stable key, name, address, availability, roles it defines). Mirrors domain/hwsApps.ts.';
create trigger hws_apps_set_updated_at before update on hws_apps for each row execute function set_updated_at();

insert into hws_apps (key, name, url, status, roles, sort_order) values
  ('abf', 'ABF Generator', '/abf', 'available', array['admin', 'user', 'external'], 10),
  ('hws-easy', 'HWS Easy', null, 'coming_soon', array['user'], 20);

-- ---------------------------------------------------------------------------------------------
-- Shared administrator flag + memberships
-- ---------------------------------------------------------------------------------------------
alter table app_users add column is_hws_admin boolean not null default false;
comment on column app_users.is_hws_admin is 'Shared HomeworkStudio administrator: manages accounts and access. Opens no application by itself.';

create table app_memberships (
  user_id uuid not null references app_users (id) on delete cascade,
  app_key text not null references hws_apps (key) on update cascade on delete restrict,
  role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references app_users (id) on delete set null,
  primary key (user_id, app_key)
);
create index app_memberships_app_role_idx on app_memberships (app_key, role);
comment on table app_memberships is 'Access of one account to one application with a role of that application. No row = no access. Removing a row blocks only that application; project assignments and history stay.';
create trigger app_memberships_set_updated_at before update on app_memberships for each row execute function set_updated_at();

-- A membership role must be one the application defines (any write path, including direct SQL).
create function app_memberships_check_role() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from hws_apps where key = new.app_key and new.role = any (roles)) then
    raise exception 'INVALID_APP_ROLE: role % neplatí pro aplikaci %.', new.role, new.app_key using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger app_memberships_check_role before insert or update of app_key, role on app_memberships for each row execute function app_memberships_check_role();

-- The former single role becomes the ABF membership, unchanged (active and deactivated accounts alike).
insert into app_memberships (user_id, app_key, role, created_at, created_by)
select id, 'abf', role, created_at, created_by from app_users;

-- ---------------------------------------------------------------------------------------------
-- Invitations: traceable state, so a partial failure is visible and a retry never duplicates
-- ---------------------------------------------------------------------------------------------
create table account_invitations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users (id) on delete cascade,
  requested_access jsonb not null check (jsonb_typeof(requested_access) = 'array'),
  status text not null check (status in ('access_pending', 'ready', 'sent', 'send_failed')),
  delivery text not null check (delivery in ('manual', 'email')),
  -- a short, non-secret reason (never a link or token)
  last_error text check (last_error is null or length(last_error) <= 300),
  created_by uuid references app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index account_invitations_user_idx on account_invitations (user_id, created_at desc);
comment on table account_invitations is 'One row per invitation attempt: access_pending → ready (access saved, link for manual hand-over) → sent / send_failed. Never stores a link or token.';
create trigger account_invitations_set_updated_at before update on account_invitations for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Last active administrators: the shared one and the admin of every application
-- ---------------------------------------------------------------------------------------------
-- Replaces app_users_keep_last_admin (V1-AUTH-01), which read the dropped app_users.role. One
-- advisory lock serializes all of these checks, so two concurrent changes of different
-- administrators cannot both pass (read committed: the second sees the first one's commit).
drop trigger app_users_keep_last_admin on app_users;
drop function app_users_keep_last_admin();

create function hws_keep_last_admins_on_account() returns trigger
language plpgsql as $$
declare
  losing_account boolean := old.is_active and (tg_op = 'DELETE' or not new.is_active);
  losing_hws boolean := old.is_active and old.is_hws_admin and (tg_op = 'DELETE' or not new.is_active or not new.is_hws_admin);
  admin_app text;
begin
  if not (losing_account or losing_hws) then
    return coalesce(new, old);
  end if;
  perform pg_advisory_xact_lock(hashtext('hws_last_admins'));
  if losing_hws and not exists (select 1 from app_users where is_hws_admin and is_active and id <> old.id) then
    raise exception 'LAST_ACTIVE_HWS_ADMIN: poslední aktivní správce HomeworkStudia nemůže být deaktivován ani odebrán.' using errcode = 'P0001';
  end if;
  if losing_account then
    for admin_app in select app_key from app_memberships where user_id = old.id and role = 'admin' loop
      if not exists (
        select 1 from app_memberships m join app_users u on u.id = m.user_id
        where m.app_key = admin_app and m.role = 'admin' and u.is_active and u.id <> old.id
      ) then
        raise exception 'LAST_ACTIVE_APP_ADMIN:%: poslední aktivní správce aplikace nemůže být deaktivován.', admin_app using errcode = 'P0001';
      end if;
    end loop;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger hws_keep_last_admins_on_account before update or delete on app_users for each row execute function hws_keep_last_admins_on_account();

create function hws_keep_last_admins_on_membership() returns trigger
language plpgsql as $$
begin
  if old.role <> 'admin' or (tg_op = 'UPDATE' and new.role = 'admin' and new.app_key = old.app_key) then
    return coalesce(new, old);
  end if;
  -- an inactive (or, during a cascade, already deleted) account is no active administrator
  if not exists (select 1 from app_users where id = old.user_id and is_active) then
    return coalesce(new, old);
  end if;
  perform pg_advisory_xact_lock(hashtext('hws_last_admins'));
  if not exists (
    select 1 from app_memberships m join app_users u on u.id = m.user_id
    where m.app_key = old.app_key and m.role = 'admin' and u.is_active and m.user_id <> old.user_id
  ) then
    raise exception 'LAST_ACTIVE_APP_ADMIN:%: poslední aktivní správce aplikace nemůže přijít o roli ani o přístup.', old.app_key using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger hws_keep_last_admins_on_membership before update or delete on app_memberships for each row execute function hws_keep_last_admins_on_membership();

-- ---------------------------------------------------------------------------------------------
-- Atomic writes of the shared administration (one transaction each: a rejected step — invalid
-- role, last administrator — leaves nothing half-changed)
-- ---------------------------------------------------------------------------------------------
-- Replaces the whole access of one account: listed applications get (or keep) their role, the
-- others lose their membership. Idempotent — repeating the same call changes nothing.
create function hws_set_memberships(p_user_id uuid, p_access jsonb, p_actor uuid) returns void
language plpgsql as $$
begin
  if jsonb_typeof(p_access) <> 'array' then
    raise exception 'INVALID_ACCESS: seznam přístupů musí být pole.' using errcode = '22023';
  end if;
  insert into app_memberships (user_id, app_key, role, created_by)
  select p_user_id, entry ->> 'appKey', entry ->> 'role', p_actor from jsonb_array_elements(p_access) entry
  on conflict (user_id, app_key) do update set role = excluded.role where app_memberships.role is distinct from excluded.role;
  delete from app_memberships
  where user_id = p_user_id and app_key not in (select entry ->> 'appKey' from jsonb_array_elements(p_access) entry);
end;
$$;

-- Name / active state / shared-admin flag and (when p_access is not null) the access, guarded by the
-- caller's updated_at (no silent overwrite of a concurrent change). Returns false on a stale version.
create function hws_update_account(
  p_user_id uuid, p_expected_updated_at timestamptz, p_set_display_name boolean, p_display_name text,
  p_is_active boolean, p_is_hws_admin boolean, p_access jsonb, p_actor uuid
) returns boolean
language plpgsql as $$
begin
  update app_users set
    display_name = case when p_set_display_name then p_display_name else display_name end,
    is_active = coalesce(p_is_active, is_active),
    is_hws_admin = coalesce(p_is_hws_admin, is_hws_admin)
  where id = p_user_id and updated_at = p_expected_updated_at;
  if not found then
    return false;
  end if;
  if p_access is not null then
    perform hws_set_memberships(p_user_id, p_access, p_actor);
  end if;
  return true;
end;
$$;

revoke all on function hws_set_memberships(uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function hws_update_account(uuid, timestamptz, boolean, text, boolean, boolean, jsonb, uuid) from public, anon, authenticated;
grant execute on function hws_set_memberships(uuid, jsonb, uuid) to service_role;
grant execute on function hws_update_account(uuid, timestamptz, boolean, text, boolean, boolean, jsonb, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- The single role column is gone: application roles live in app_memberships only
-- ---------------------------------------------------------------------------------------------
alter table app_users drop column role;
comment on table app_users is 'Shared HomeworkStudio account (V1-AUTH-02): identity, name, e-mail, active state, shared-administrator flag. Application access and roles: app_memberships. No password here — Supabase Auth owns credentials.';

alter table hws_apps enable row level security;
alter table app_memberships enable row level security;
alter table account_invitations enable row level security;
revoke all on hws_apps, app_memberships, account_invitations from anon, authenticated;
revoke all on function app_memberships_check_role() from public, anon, authenticated;
revoke all on function hws_keep_last_admins_on_account() from public, anon, authenticated;
revoke all on function hws_keep_last_admins_on_membership() from public, anon, authenticated;
