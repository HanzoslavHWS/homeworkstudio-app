-- ROLLBACK of 20261111120000_app_support (V1-SUPPORT-01) — NOT a migration. DEV only, after checking
-- the target. Order (docs/SUPPORT.md, chapter 8):
--   1. files of attachments (R2 support/…) while the support code and tables still exist:
--      npm run support:dev:cleanup -- --all --apply --confirm=<dev ref>
--   2. stop the application and the dispatch scheduler
--   3. 20261112120000_support_notifications.down.sql, then THIS script
--   4. switch the code back before V1-SUPPORT-01, start the application
-- Removes the support tables and functions. Nothing else (accounts, memberships, projects, catalog)
-- is touched.

begin;

drop function support_save_article(uuid, text, uuid, integer, text, text, text, text, text, text[], boolean, text, integer, uuid[]);
drop function support_update_ticket(uuid, uuid, timestamptz, boolean, text, boolean, uuid);
drop function support_add_message(uuid, uuid, uuid, text, text, uuid[], boolean);
drop function support_create_ticket(text, uuid, uuid, text, text, text, text, text, text, text, jsonb, uuid[]);
drop function support_attach(text, uuid, uuid[], uuid, uuid, uuid);
drop table support_attachments;
drop table support_ticket_events;
drop table support_ticket_messages;
drop table support_tickets;
drop table support_article_comments;
drop table support_article_versions;
drop table support_articles;

delete from supabase_migrations.schema_migrations where version = '20261111120000';

commit;
