-- ROLLBACK of 20261112120000_support_notifications (V1-SUPPORT-02) — NOT a migration. DEV only, after
-- checking the target, with the application and the dispatch scheduler STOPPED; afterwards switch the
-- code back before V1-SUPPORT-02 (docs/SUPPORT.md, chapter 8). Removes the notification outbox (the
-- record of sent / queued support e-mails). Reports, replies and attachments stay untouched.
-- When rolling back the whole support feature: files first (support:dev:cleanup), then this script,
-- then 20261111120000_app_support.down.sql.

begin;

drop function support_claim_notifications(integer, uuid[]);
drop table support_notifications;

delete from supabase_migrations.schema_migrations where version = '20261112120000';

commit;
