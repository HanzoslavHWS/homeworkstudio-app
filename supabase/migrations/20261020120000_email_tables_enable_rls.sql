-- Security: enable Row Level Security on the two tables that were created without it
-- (20260901120000_email_templates.sql, 20260901140000_email_history.sql). Every other table
-- already follows this convention.
--
-- Same rule as the rest of the schema: RLS on, ZERO policies. The browser never talks to Postgres
-- directly; app/api/emails/* use the server-only service-role client (lib/db/supabase.server.ts),
-- which bypasses RLS, so the application keeps working unchanged. The anon and authenticated
-- roles (Supabase client keys) lose all access to these rows.

alter table email_templates enable row level security;
alter table email_history enable row level security;
