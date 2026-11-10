-- ROLLBACK of 20261110120000_hws_accounts_app_memberships (V1-AUTH-02) — NOT a migration.
-- Run by hand, only together with switching the code back before V1-AUTH-02 (develop 2f8b372), and
-- only against DEV after checking the target (see docs/AUTH_SETUP.md "Návrat před V1-AUTH-02").
--
-- Restores app_users.role from the ABF membership. An account WITHOUT an ABF membership had no ABF
-- access in the new model; the old model knows no "no access" state, so such an account comes back
-- DEACTIVATED with role 'external' (it cannot sign in) — reactivate it deliberately if wanted.
-- Accounts, ids, passwords, sessions, project assignments and history stay. Removed: the
-- application registry, memberships of other applications, the shared-admin flag and invitations.

begin;

alter table app_users add column role text;
update app_users u set role = m.role from app_memberships m where m.user_id = u.id and m.app_key = 'abf';
-- Deactivation fires the session-revoking trigger, so no old cookie of such an account keeps working.
update app_users set role = 'external', is_active = false where role is null;
alter table app_users alter column role set not null;
alter table app_users add constraint app_users_role_check check (role in ('admin', 'user', 'external'));

drop function hws_update_account(uuid, timestamptz, boolean, text, boolean, boolean, jsonb, uuid);
drop function hws_set_memberships(uuid, jsonb, uuid);
drop trigger hws_keep_last_admins_on_account on app_users;
drop function hws_keep_last_admins_on_account();
drop table account_invitations;
drop table app_memberships;
drop function hws_keep_last_admins_on_membership();
drop function app_memberships_check_role();
drop table hws_apps;
alter table app_users drop column is_hws_admin;

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
revoke all on function app_users_keep_last_admin() from public, anon, authenticated;
comment on table app_users is 'Server-managed profile of a Supabase Auth user: role (admin/user/external) and active state. No password here — Supabase Auth owns credentials.';

-- the migration runner's history: forget the rolled-back version (Supabase CLI table)
delete from supabase_migrations.schema_migrations where version = '20261110120000';

commit;
