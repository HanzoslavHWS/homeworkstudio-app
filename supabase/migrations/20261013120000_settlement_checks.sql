-- Kontrola vyúčtování realizaček (batch 1) — comparing what ABF ordered with what a realization
-- company billed, per stand (domain/settlementCheck.ts). Fully relational, like tasks /
-- email_history: everything here is filtered, joined and re-read on every recompute.
--
-- PURELY ADDITIVE. No existing table, column, code or name is altered. catalog_items is only
-- REFERENCED (new FKs point at it); its abf_code / internal_code / display_name / official_name
-- stay exactly as they are.
--
-- NO DUPLICATE ENTITIES — every link points at what already exists:
--   - event       -> events.id (text FK, same as tasks / print_surface_projects)
--   - realizačka  -> print_surface_realization_companies.id, as a SOFT reference (plain text, no
--                    FK — same as price_lists.realization_company_id). That catalog is replaced
--                    wholesale by the Tiskové plochy Excel import (delete + insert); a hard FK
--                    from here would make that existing import fail. Company ids are
--                    deterministic slugs, so a re-import recreates the same id; the company name
--                    is also snapshotted on the check.
--   - component   -> catalog_items.id (uuid FK, ON DELETE RESTRICT by default — a card used in a
--                    dictionary entry or a name alias can only be archived, never hard-deleted)
--   - stand       -> stand_key text (domain/settlementCheck.ts settlementStandKey). Stand
--                    identity across modules stays event + stand number; no stands table.
--   - people      -> free-text created_by / verified_by (no users table, one shared login —
--                    same convention as tasks.created_by).
--
-- Catalog names (spec section 4) after this migration:
--   A. ABF code               -> catalog_items.abf_code            (exists, unchanged)
--   B. original ABF name      -> catalog_items.official_name       (exists, managed by the KODY
--                                import — domain/catalogAbfImport.ts) + catalog_item_names
--                                rows of type 'abf_original' for cards the KODY import never set
--   C. our display name       -> catalog_items.display_name        (exists, unchanged)
--   D. alternative ABF names  -> catalog_item_names, type 'abf_alternative'   (new)
--   E. realization-company    -> settlement_vendor_mappings — always tied to ONE company (new)
--      names
-- Nothing is backfilled into catalog_item_names: _IMPORT/KODY.xlsm stays a reference only.
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually
-- (e.g. `supabase db push` or the Supabase SQL editor) only after explicit review.

-- =========================================================================
-- CATALOG ITEM NAMES — additional ABF names of a catalog card.
-- =========================================================================
create table catalog_item_names (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid not null references catalog_items (id),
  name_type text not null check (name_type in ('abf_original', 'abf_alternative')),
  name text not null check (length(btrim(name)) > 0),
  normalized_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table catalog_item_names is 'Additional ABF names of a catalog card (historical / differently worded). The card''s own columns are never rewritten from here.';
comment on column catalog_item_names.normalized_name is 'normalizeSettlementText(name): lower-case, no diacritics, single spaces. One ABF name leads to exactly one card.';

-- One ABF name must lead to exactly one card, otherwise an order line could not be resolved.
create unique index catalog_item_names_normalized_name_key on catalog_item_names (normalized_name);
create index catalog_item_names_catalog_item_id_idx on catalog_item_names (catalog_item_id);

create trigger catalog_item_names_set_updated_at before update on catalog_item_names for each row execute function set_updated_at();

-- =========================================================================
-- CHECKS — one per event + realization company. More files (hall 3, hall 4) go into the same check.
-- =========================================================================
create table settlement_checks (
  id uuid primary key default gen_random_uuid(),
  event_id text not null references events (id),
  realization_company_id text not null,
  realization_company_name text not null,
  status text not null default 'draft' check (status in ('draft', 'in_progress', 'reviewed', 'closed')),
  note text,
  created_by text,
  current_run_id uuid,
  summary jsonb,
  stand_index jsonb not null default '[]'::jsonb,
  last_compared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint settlement_checks_event_company_key unique (event_id, realization_company_id)
);

comment on column settlement_checks.realization_company_id is 'Soft reference to print_surface_realization_companies.id — no FK on purpose (see header).';
comment on column settlement_checks.current_run_id is 'run_id of the settlement_results rows that are current. Results of older runs are deleted only after this is switched.';
comment on column settlement_checks.summary is 'SettlementRunSummary of the current run (stand counts, row counts per status).';
comment on column settlement_checks.stand_index is 'Stands of the current run [{ standKey, displayNumber, matchState, … }] — also lists stands that have no result row.';

create trigger settlement_checks_set_updated_at before update on settlement_checks for each row execute function set_updated_at();

-- =========================================================================
-- IMPORTED FILES — metadata only; the parsed original rows live in the tables below.
-- =========================================================================
create table settlement_import_files (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references settlement_checks (id) on delete cascade,
  side text not null check (side in ('abf', 'vendor')),
  format text not null check (format in ('xlsx', 'pdf')),
  parser text not null,
  file_name text not null,
  file_size integer not null default 0,
  fingerprint text not null,
  status text not null default 'importing' check (status in ('importing', 'imported', 'superseded')),
  summary jsonb not null default '{}'::jsonb,
  created_by text,
  imported_at timestamptz not null default now()
);

comment on column settlement_import_files.fingerprint is 'SHA-256 of the file bytes.';
comment on column settlement_import_files.status is 'importing = rows are still being written (never read by the comparison); imported = current; superseded = replaced by a newer version, original rows kept.';

-- The same bytes can be current only once per check and side — a repeated upload cannot duplicate rows.
create unique index settlement_import_files_active_fingerprint_key on settlement_import_files (check_id, side, fingerprint) where status in ('importing', 'imported');
create index settlement_import_files_check_id_idx on settlement_import_files (check_id);

-- =========================================================================
-- STANDS — one row per ABF order block / per vendor sheet, exactly as imported.
-- =========================================================================
create table settlement_stands (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references settlement_checks (id) on delete cascade,
  file_id uuid not null references settlement_import_files (id) on delete cascade,
  side text not null check (side in ('abf', 'vendor')),
  label text not null,
  stand_number_raw text,
  stand_key text,
  manual_stand_key text,
  unassigned_reason text,
  title text,
  exhibitor_name text,
  document_number text,
  source_row integer,
  source_page integer,
  sort_order integer not null default 0
);

comment on column settlement_stands.label is 'Vendor: the sheet name. ABF: the stand cell. Always the original text.';
comment on column settlement_stands.stand_key is 'settlementStandKey() of the imported stand number; NULL = could not be read as one stand (sheet "ostatní", "13", "4C1-2"). Never invented.';
comment on column settlement_stands.manual_stand_key is 'Stand the USER filed an unassigned sheet under. Wins over stand_key.';

create index settlement_stands_check_id_idx on settlement_stands (check_id);
create index settlement_stands_file_id_idx on settlement_stands (file_id);

-- =========================================================================
-- ORIGINAL ABF ORDER LINES
-- =========================================================================
create table settlement_abf_items (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references settlement_checks (id) on delete cascade,
  file_id uuid not null references settlement_import_files (id) on delete cascade,
  stand_id uuid not null references settlement_stands (id) on delete cascade,
  source_row integer,
  source_page integer,
  raw_name text not null,
  normalized_name text not null,
  abf_code text,
  quantity numeric,
  quantity_raw text not null default '',
  quantity_issue text,
  unit_raw text,
  unit text,
  note text,
  raw jsonb
);

comment on column settlement_abf_items.raw_name is 'Item text exactly as in the ABF report (it is cut at ~40 characters there).';
comment on column settlement_abf_items.abf_code is 'Code found IN the item text ("T18 - TYPOVÝ STÁNEK…"). The ABF report has no code column.';
comment on column settlement_abf_items.raw is 'The source row''s cells (XLSX) or positioned text runs (PDF).';

create index settlement_abf_items_check_id_idx on settlement_abf_items (check_id);
create index settlement_abf_items_file_id_idx on settlement_abf_items (file_id);

-- =========================================================================
-- ORIGINAL VENDOR BILLING ROWS — every row of every sheet, including the unfilled template rows.
-- =========================================================================
create table settlement_vendor_items (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references settlement_checks (id) on delete cascade,
  file_id uuid not null references settlement_import_files (id) on delete cascade,
  stand_id uuid not null references settlement_stands (id) on delete cascade,
  source_sheet text not null,
  source_row integer not null,
  raw_name text not null,
  normalized_name text not null,
  unit_price numeric,
  quantity numeric,
  quantity_raw text not null default '',
  quantity_issue text,
  line_total numeric,
  unit text,
  unit_source text not null default 'default' check (unit_source in ('name', 'default')),
  note text,
  row_kind text not null default 'item' check (row_kind in ('item', 'surcharge', 'total')),
  is_billed boolean not null default false,
  raw jsonb
);

comment on column settlement_vendor_items.is_billed is 'true only for a row with a real non-zero quantity. Template rows (blank / 0) are stored for traceability and never compared.';
comment on column settlement_vendor_items.unit_price is 'Imported and kept; prices are NOT compared in batch 1.';

create index settlement_vendor_items_check_id_idx on settlement_vendor_items (check_id);
create index settlement_vendor_items_stand_id_idx on settlement_vendor_items (stand_id);
create index settlement_vendor_items_file_id_idx on settlement_vendor_items (file_id);

-- =========================================================================
-- DICTIONARY — a realization company's own item text -> our catalog component. Global per
-- company (not per check), so a confirmed entry is reused by every later import of that company.
-- The same text at another company is a separate entry and may mean a different component.
-- =========================================================================
create table settlement_vendor_mappings (
  id uuid primary key default gen_random_uuid(),
  realization_company_id text not null,
  source_text text not null,
  normalized_text text not null,
  catalog_item_id uuid references catalog_items (id),
  unit text,
  status text not null default 'suggested' check (status in ('suggested', 'confirmed', 'unclear')),
  origin text not null default 'manual' check (origin in ('manual', 'import', 'ai_suggestion')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint settlement_vendor_mappings_company_text_key unique (realization_company_id, normalized_text),
  constraint settlement_vendor_mappings_confirmed_has_item check (status <> 'confirmed' or catalog_item_id is not null)
);

comment on column settlement_vendor_mappings.catalog_item_id is 'NULL = not recognized yet.';
comment on column settlement_vendor_mappings.unit is 'Overrides the unit read from the item text when set.';
comment on column settlement_vendor_mappings.status is 'Only "confirmed" entries are used by the comparison.';
comment on column settlement_vendor_mappings.origin is 'manual = a person; import = added unresolved by a file import; ai_suggestion = reserved for a future AI proposer (always arrives as "suggested").';

create index settlement_vendor_mappings_catalog_item_id_idx on settlement_vendor_mappings (catalog_item_id);

create trigger settlement_vendor_mappings_set_updated_at before update on settlement_vendor_mappings for each row execute function set_updated_at();

-- =========================================================================
-- RULES of a realization company. Batch 1 evaluates only rule_type = 'out_of_scope'; the other
-- types are stored for the future engine (domain/settlementRules.ts). A rule can never be active
-- without a named verifier.
-- =========================================================================
create table settlement_vendor_rules (
  id uuid primary key default gen_random_uuid(),
  realization_company_id text not null,
  event_id text references events (id) on delete cascade,
  rule_type text not null check (rule_type in ('out_of_scope', 'unit_conversion', 'merge_abf_items', 'split_vendor_item', 'wall_booth_billing', 'type_booth_exception', 'custom')),
  name text not null check (length(btrim(name)) > 0),
  explanation text not null check (length(btrim(explanation)) > 0),
  definition jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'active', 'disabled')),
  origin text not null default 'manual' check (origin in ('manual', 'import', 'ai_suggestion')),
  verified_at timestamptz,
  verified_by text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint settlement_vendor_rules_active_is_verified check (status <> 'active' or (verified_at is not null and verified_by is not null))
);

comment on column settlement_vendor_rules.event_id is 'NULL = applies to every event of the company; set = an individual rule for one event.';
comment on column settlement_vendor_rules.explanation is 'Plain-language reason shown to the user whenever the rule changes a result.';

create index settlement_vendor_rules_company_idx on settlement_vendor_rules (realization_company_id);

create trigger settlement_vendor_rules_set_updated_at before update on settlement_vendor_rules for each row execute function set_updated_at();

-- =========================================================================
-- RESULTS of the comparison — rewritten by every recompute (new run_id first, old run deleted
-- only after settlement_checks.current_run_id points at the new one).
-- =========================================================================
create table settlement_results (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references settlement_checks (id) on delete cascade,
  run_id uuid not null,
  stand_key text not null,
  row_key text not null,
  status text not null check (status in ('match', 'difference', 'only_abf', 'only_vendor', 'unclear', 'requires_rule', 'out_of_scope')),
  label text not null,
  catalog_item_id uuid,
  abf_code text,
  abf_quantity numeric,
  abf_unit text,
  vendor_quantity numeric,
  vendor_unit text,
  difference numeric,
  abf_line_ids jsonb not null default '[]'::jsonb,
  vendor_line_ids jsonb not null default '[]'::jsonb,
  explanation jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0
);

comment on column settlement_results.row_key is 'Stable across runs: item:<catalog id> | abf:<normalized name> | vendor:<normalized name>. settlement_decisions are keyed by it.';
comment on column settlement_results.difference is 'billed − ordered. NULL whenever the two quantities are not comparable.';
comment on column settlement_results.catalog_item_id is 'Deliberately no FK: a result is a snapshot and must not block archiving/removing a card.';
comment on column settlement_results.abf_line_ids is 'ids of the settlement_abf_items the row was built from.';
comment on column settlement_results.explanation is '{ abfMatch[], vendorMappingConfirmed, reasons[], ruleIds[], candidateCatalogItemIds[] } — why the row has its status.';

create index settlement_results_check_run_idx on settlement_results (check_id, run_id);

-- =========================================================================
-- MANUAL DECISIONS — the user's verdict on one compared row. Keyed by stand + row key, never by
-- a result row id, so a decision survives every recompute and re-import.
-- =========================================================================
create table settlement_decisions (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references settlement_checks (id) on delete cascade,
  stand_key text not null,
  row_key text not null,
  decision text check (decision in ('accepted', 'disputed')),
  note text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint settlement_decisions_row_key unique (check_id, stand_key, row_key)
);

create trigger settlement_decisions_set_updated_at before update on settlement_decisions for each row execute function set_updated_at();

-- =========================================================================
-- Browser must never talk to Postgres directly — enable RLS with zero policies on every table
-- (same convention as init_schema.sql section 32); the server-only service-role client bypasses
-- RLS by design, and every API route checks the app session first.
-- =========================================================================
alter table catalog_item_names enable row level security;
alter table settlement_checks enable row level security;
alter table settlement_import_files enable row level security;
alter table settlement_stands enable row level security;
alter table settlement_abf_items enable row level security;
alter table settlement_vendor_items enable row level security;
alter table settlement_vendor_mappings enable row level security;
alter table settlement_vendor_rules enable row level security;
alter table settlement_results enable row level security;
alter table settlement_decisions enable row level security;
