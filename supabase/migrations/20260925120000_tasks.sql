-- Úkoly / Kalendář — a simple internal task list linked to the generator's existing data
-- (domain/tasks.ts). Fully relational (email_history / print_surface_* style), because the list
-- filters and sorts on almost every field.
--
-- NO DUPLICATE ENTITIES — every link points at what already exists:
--   - event          -> events.id (text FK, same as projects / print_surface_projects / technical_raster_projects)
--   - realizačka     -> print_surface_realization_companies.id (the imported realization-company catalog)
--   - company        -> company_name text. There is no companies table; projects.company_name and
--                       print_surface_projects.company_name are free text too.
--   - stand          -> stand_number text (normalized with domain/technicalStandNumber.ts's
--                       normalizeStandNumber). Stand identity across modules is event + stand number.
--   - source record  -> source_type + source_id (booth project, print-surface project, technical
--                       raster project, event). Deliberately no FK: a task may be created from a
--                       record that is not saved to the DB yet, and a deleted source must not delete the task.
--   - people         -> assignee_name / created_by / actor_name are free text. There is no users
--                       table and the login is a single shared session (same "reserved for a future
--                       per-user login" convention as print_surface_projects.created_by).
--   - event milestones are NOT stored here: they are derived from the existing events document
--     (assemblyDate, eventFrom, eventTo, disassemblyDate, materialDataDeadline,
--     designApprovalDeadline, deadlines[]) — see domain/tasks.ts deriveEventMilestones.
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually
-- (e.g. `supabase db push` or the Supabase SQL editor) only after explicit review.

-- =========================================================================
-- CATEGORIES — a table (not a check constraint) so new categories are just new rows.
-- =========================================================================
create table task_categories (
  id text primary key,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger task_categories_set_updated_at before update on task_categories for each row execute function set_updated_at();

insert into task_categories (id, name, sort_order) values
  ('graphics', 'Grafika', 10),
  ('technical', 'Technika', 20),
  ('electricity', 'Elektrika', 30),
  ('internet', 'Internet', 40),
  ('water_waste', 'Voda / odpad', 50),
  ('furniture', 'Mobiliář', 60),
  ('construction', 'Konstrukce', 70),
  ('print', 'Tisk', 80),
  ('review', 'Kontrola', 90),
  ('email', 'E-mail', 100),
  ('client', 'Klient', 110),
  ('assembly', 'Montáž', 120),
  ('administration', 'Administrativa', 130),
  ('other', 'Ostatní', 140);

-- =========================================================================
-- RECURRENCE — schema only for now (domain/tasks.ts TaskRecurrenceRule); no generator runs yet.
-- =========================================================================
create table task_recurring_rules (
  id uuid primary key default gen_random_uuid(),
  frequency text not null check (frequency in ('daily', 'weekly', 'weekdays', 'interval_days')),
  interval_days integer check (interval_days is null or interval_days > 0),
  next_due_date date,
  ends_on date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_recurring_rules_interval check ((frequency = 'interval_days') = (interval_days is not null))
);

create trigger task_recurring_rules_set_updated_at before update on task_recurring_rules for each row execute function set_updated_at();

-- =========================================================================
-- TASKS
-- =========================================================================
create table tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) > 0),
  description text,
  status text not null default 'new' check (status in ('new', 'in_progress', 'waiting', 'review', 'done', 'cancelled')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  category_id text references task_categories (id),
  due_date date,
  due_time time,
  event_id text references events (id) on delete set null,
  company_name text,
  stand_number text,
  realization_company_id text references print_surface_realization_companies (id) on delete set null,
  assignee_name text,
  created_by text,
  source_type text not null default 'manual' check (source_type in ('manual', 'booth_project', 'print_surface_project', 'technical_raster_project', 'event')),
  source_id text,
  is_automatic boolean not null default false,
  automation_key text unique,
  waiting_since date,
  recurring_rule_id uuid references task_recurring_rules (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint tasks_due_time_needs_date check (due_time is null or due_date is not null),
  constraint tasks_automation_key_only_automatic check (automation_key is null or is_automatic)
);

comment on column tasks.company_name is 'Free text, same as projects.company_name — no companies table exists.';
comment on column tasks.stand_number is 'Normalized stand number (normalizeStandNumber). Stand identity across modules is event_id + stand_number.';
comment on column tasks.source_type is 'Which module/record the task was created from; source_id is that record''s id. No FK on purpose (see header).';
comment on column tasks.is_automatic is 'true = created by an automatic rule (domain/tasks.ts AutomaticTaskRule), false = manual.';
comment on column tasks.automation_key is 'Stable key of the automatic rule + record that produced the task — prevents the same automatic task from being created twice.';
comment on column tasks.waiting_since is 'When the task entered "Čekáme" — drives "Čekáme N dní".';
comment on column tasks.created_by is 'Free-text name of the author — no users table yet (same convention as print_surface_projects.created_by).';

create index tasks_status_idx on tasks (status);
create index tasks_due_date_idx on tasks (due_date);
create index tasks_event_id_idx on tasks (event_id);
create index tasks_event_stand_idx on tasks (event_id, stand_number);
create index tasks_source_idx on tasks (source_type, source_id);

create trigger tasks_set_updated_at before update on tasks for each row execute function set_updated_at();

-- =========================================================================
-- HISTORY — one row per change, written by the server-side task service.
-- =========================================================================
create table task_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  action text not null check (action in ('created', 'updated', 'status_changed', 'completed', 'reopened', 'approved', 'returned')),
  changes jsonb not null default '[]'::jsonb,
  note text,
  actor_name text,
  created_at timestamptz not null default now()
);

comment on column task_history.changes is 'Array of { field, from, to } for the fields this action changed.';
comment on column task_history.note is 'Optional free-text note, e.g. the reason when a task is returned from "Ke kontrole".';

create index task_history_task_id_idx on task_history (task_id, created_at);

-- =========================================================================
-- STAND CHECKLIST — configurable templates (a global default + optional per-event templates),
-- and per-stand state keyed by event + stand number (the cross-module stand identity).
-- =========================================================================
create table stand_checklist_templates (
  id text primary key,
  name text not null,
  event_id text references events (id) on delete cascade,
  is_default boolean not null default false,
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column stand_checklist_templates.items is 'Ordered array of { key, label }. A stand''s checklist uses its event''s template when one exists, otherwise the default one.';

create unique index stand_checklist_templates_event_idx on stand_checklist_templates (event_id) where event_id is not null;
create unique index stand_checklist_templates_default_idx on stand_checklist_templates (is_default) where is_default;

create trigger stand_checklist_templates_set_updated_at before update on stand_checklist_templates for each row execute function set_updated_at();

insert into stand_checklist_templates (id, name, is_default, items) values (
  'default',
  'Výchozí checklist stánku',
  true,
  '[
    {"key": "construction", "label": "Konstrukce"},
    {"key": "furniture", "label": "Mobiliář"},
    {"key": "electricity", "label": "Elektrika"},
    {"key": "internet", "label": "Internet"},
    {"key": "carpet", "label": "Koberec"},
    {"key": "graphics", "label": "Grafika"},
    {"key": "print_data", "label": "Tisková data"},
    {"key": "visual_approved", "label": "Vizuál potvrzen"},
    {"key": "technical_services_placed", "label": "Technické služby umístěné"},
    {"key": "ready_for_assembly", "label": "Připraveno k montáži"}
  ]'::jsonb
);

create table stand_checklist_entries (
  event_id text not null references events (id) on delete cascade,
  stand_number text not null,
  item_key text not null,
  is_done boolean not null default false,
  done_at timestamptz,
  done_by text,
  updated_at timestamptz not null default now(),
  primary key (event_id, stand_number, item_key)
);

comment on column stand_checklist_entries.item_key is 'Key from the resolved template''s items[]. A key that no longer exists in the template is simply not shown.';

create trigger stand_checklist_entries_set_updated_at before update on stand_checklist_entries for each row execute function set_updated_at();

-- =========================================================================
-- Browser must never talk to Postgres directly — enable RLS with zero policies on every table
-- (same convention as init_schema.sql section 32); the server-only service-role client bypasses
-- RLS by design, and every API route checks the app session first.
-- =========================================================================
alter table task_categories enable row level security;
alter table task_recurring_rules enable row level security;
alter table tasks enable row level security;
alter table task_history enable row level security;
alter table stand_checklist_templates enable row level security;
alter table stand_checklist_entries enable row level security;
