-- V1-AUTH-01: user accounts, roles, revocable sessions and project assignments.
--
-- Identity and passwords live in Supabase Auth (auth.users) — this app never stores a password.
-- app_users is the SERVER-MANAGED profile: role and active state are written only by the server
-- (service role) after a permission check; never taken from auth user_metadata or the client.
-- app_sessions makes every login revocable (logout, deactivation, password change) and lets the
-- server reject an old cookie immediately. project_members assigns users to 3D projects
-- (projects.id); global data (catalog, price lists, events) is never opened by an assignment.
--
-- Like every table of this schema: RLS on, no policies, no grants for anon/authenticated — the
-- browser never talks to PostgREST; all access goes through the authorized Next.js API routes.

create table app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text,
  role text not null check (role in ('admin', 'user', 'external')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references app_users (id) on delete set null,
  deactivated_at timestamptz,
  constraint app_users_email_lowercase check (email = lower(email))
);
create unique index app_users_email_key on app_users (email);
comment on table app_users is 'Server-managed profile of a Supabase Auth user: role (admin/user/external) and active state. No password here — Supabase Auth owns credentials.';

create trigger app_users_set_updated_at before update on app_users for each row execute function set_updated_at();

create table app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text
);
create index app_sessions_user_idx on app_sessions (user_id) where revoked_at is null;
comment on table app_sessions is 'One row per login. The signed cookie carries only the session id; the server checks this row (not revoked, not expired) and the user (active) on every request.';

create table project_members (
  project_id text not null references projects (id) on delete cascade,
  user_id uuid not null references app_users (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references app_users (id) on delete set null,
  primary key (project_id, user_id)
);
create index project_members_user_idx on project_members (user_id);
comment on table project_members is 'Explicit assignment of a user to a 3D project (projects.id). Grants access to that project and its project files only — never to global catalog, prices or other projects.';

-- At least one active admin must remain once one exists. Enforced in the database (any path,
-- including direct SQL) and serialized by an advisory lock, so two concurrent demotions /
-- deactivations of different admins cannot both pass.
create function app_users_keep_last_admin() returns trigger
language plpgsql as $$
declare
  remaining integer;
begin
  if (tg_op = 'DELETE' and old.role = 'admin' and old.is_active)
     or (tg_op = 'UPDATE' and old.role = 'admin' and old.is_active and (new.role <> 'admin' or not new.is_active)) then
    perform pg_advisory_xact_lock(hashtext('app_users_last_admin'));
    select count(*) into remaining from app_users where role = 'admin' and is_active and id <> old.id;
    if remaining = 0 then
      raise exception 'LAST_ACTIVE_ADMIN: poslední aktivní správce nemůže být deaktivován ani degradován.' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger app_users_keep_last_admin before update or delete on app_users for each row execute function app_users_keep_last_admin();

-- Deactivation revokes every open session at once (the server also checks is_active per request).
create function app_users_revoke_sessions_on_deactivate() returns trigger
language plpgsql as $$
begin
  if old.is_active and not new.is_active then
    update app_sessions set revoked_at = now(), revoke_reason = 'deactivated' where user_id = new.id and revoked_at is null;
    new.deactivated_at := now();
  elsif not old.is_active and new.is_active then
    new.deactivated_at := null;
  end if;
  return new;
end;
$$;

create trigger app_users_revoke_sessions_on_deactivate before update of is_active on app_users for each row execute function app_users_revoke_sessions_on_deactivate();

alter table app_users enable row level security;
alter table app_sessions enable row level security;
alter table project_members enable row level security;
revoke all on app_users, app_sessions, project_members from anon, authenticated;
revoke all on function app_users_keep_last_admin() from public, anon, authenticated;
revoke all on function app_users_revoke_sessions_on_deactivate() from public, anon, authenticated;
