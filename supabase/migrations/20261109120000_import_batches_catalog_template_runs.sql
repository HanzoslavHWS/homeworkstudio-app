-- V1-IMPORT-UI-01: evidence of catalog-template Excel imports run from the admin UI
-- (Administrace → Katalog komponent → Import Excel). A minimal extension of the existing
-- import_batches audit trail — no new table:
--   * one row per preview (status 'previewed' / 'no_changes'), bound to the user, the target
--     environment, the SHA-256 of the uploaded file and a hash of the server-computed plan;
--   * the confirmation claims exactly that row (previewed → running) with one conditional UPDATE,
--     so a double click, a repeated request or a second tab cannot write twice;
--   * at most ONE running catalog-template import at a time (partial unique index — works across
--     server instances, no shared memory needed);
--   * per-row results (written / failed / not attempted) are stored as the import progresses, so
--     the state of a run can be read again after a lost connection.
-- The file content itself is never stored. Existing rows (dry_run / applied / failed) stay valid.

alter table import_batches
  add column kind text,
  add column created_by uuid references app_users (id) on delete set null,
  add column environment text,
  add column file_sha256 text,
  add column file_size integer,
  add column plan_hash text,
  add column preview_expires_at timestamptz,
  add column started_at timestamptz,
  add column finished_at timestamptz,
  add column result_rows jsonb,
  add column error_message text;

alter table import_batches drop constraint import_batches_status_check;
alter table import_batches add constraint import_batches_status_check
  check (status in ('dry_run', 'applied', 'failed', 'previewed', 'no_changes', 'superseded', 'running', 'succeeded', 'partial', 'interrupted'));

create unique index import_batches_one_running_per_kind on import_batches (kind) where status = 'running';
create index import_batches_kind_created_idx on import_batches (kind, created_at desc);

comment on column import_batches.kind is 'NULL = legacy batch imports; ''catalog-template'' = Excel import of the catalog template from the admin UI (V1-IMPORT-UI-01).';
comment on column import_batches.plan_hash is 'SHA-256 of the server-computed plan at preview time; the confirmation re-plans against the current database and must produce the same hash, otherwise nothing is written.';
comment on column import_batches.result_rows is 'Per-row outcome of a confirmed run (written / failed / not_attempted), updated as the run progresses.';

-- RLS stays on (init schema); no access for anon / authenticated.
revoke all on import_batches, import_rows from anon, authenticated;
