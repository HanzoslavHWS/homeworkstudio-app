-- V1-DATA-02 (M3) — one register of realization companies (docs/V1_DATA_ARCHITECTURE.md 1.5,
-- docs/V1_DATA_DECISIONS.md A2/A9/A21).
--
-- Decision A9: `print_surface_realization_companies` stays the canonical table (tasks and
-- print-surface projects have FKs to it, settlement checks reference it by text). It is NOT renamed;
-- it gets the firm-card columns, and the neutral view `realization_companies` is the shared SQL
-- interface for other modules.
--
-- Additive only: no column or row is dropped, no project document is touched.
--   - Firms are never deleted (trigger) and their id never changes (trigger) — deactivate instead.
--   - Alternative / historical names live in `realization_company_aliases`; an alias is never
--     deleted either, only deactivated, and one active alias can belong to one firm only.
--   - The old placeholder ids from data/realizationProfiles.ts are recorded in
--     `realization_company_legacy_ids` WITHOUT a firm (decision A2): `default` is the system mode
--     "no production-size override", `realization-2..4` are unresolved. Nothing is converted.
--   - "Ostatní / neurčeno" is not a row: it is a NULL realization_company_id
--     (see domain/realizationCompanyIdentity.ts).

-- =========================================================================
-- Firm card
-- =========================================================================
alter table print_surface_realization_companies
  add column legal_name text,
  add column abra_name text,
  add column ico text,
  add column dic text,
  add column contacts jsonb not null default '[]'::jsonb,
  add column source text not null default 'import' check (source in ('import', 'manual'));

alter table print_surface_realization_companies
  add constraint print_surface_realization_companies_name_not_blank check (btrim(name) <> ''),
  add constraint print_surface_realization_companies_ico_format check (ico is null or ico ~ '^[0-9]{8}$'),
  add constraint print_surface_realization_companies_dic_format check (dic is null or dic ~ '^[A-Z]{2}[0-9A-Z]{2,13}$'),
  add constraint print_surface_realization_companies_contacts_array check (jsonb_typeof(contacts) = 'array');

create unique index print_surface_realization_companies_ico_key on print_surface_realization_companies (ico) where ico is not null;

comment on column print_surface_realization_companies.id is 'Stable internal id, never changed after insert (trigger). Imported firms: slug of the Excel header (slugifyCompanyName in domain/printSurfaceExcelImport.ts). Manual firms: createRealizationCompanyId in domain/realizationCompanyIdentity.ts.';
comment on column print_surface_realization_companies.name is 'Pracovní / zobrazovaný název.';
comment on column print_surface_realization_companies.legal_name is 'Oficiální právní název.';
comment on column print_surface_realization_companies.abra_name is 'Název firmy v ABRA.';
comment on column print_surface_realization_companies.note is 'Interní poznámka.';
comment on column print_surface_realization_companies.contacts is 'Array of { id, name?, role?, email?, phone?, note? }.';
comment on column print_surface_realization_companies.source is 'import = created by the print-surface Excel sync; manual = created in Administrace. A sync may deactivate only import firms, and only when asked to.';

create or replace function realization_companies_prevent_delete() returns trigger as $$
begin
  raise exception 'Realizační firmu % nelze smazat, lze ji jen deaktivovat.', old.id using errcode = 'P0001';
end;
$$ language plpgsql;

create trigger print_surface_realization_companies_prevent_delete before delete on print_surface_realization_companies for each row execute function realization_companies_prevent_delete();

create or replace function realization_companies_prevent_id_change() returns trigger as $$
begin
  if new.id is distinct from old.id then
    raise exception 'ID realizační firmy % nelze změnit.', old.id using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger print_surface_realization_companies_prevent_id_change before update of id on print_surface_realization_companies for each row execute function realization_companies_prevent_id_change();

-- =========================================================================
-- Alternative and historical names
-- =========================================================================
create table realization_company_aliases (
  id uuid primary key default gen_random_uuid(),
  realization_company_id text not null references print_surface_realization_companies (id) on delete restrict,
  alias text not null check (btrim(alias) <> ''),
  normalized_alias text not null check (normalized_alias <> ''),
  kind text not null default 'alternative' check (kind in ('alternative', 'historical')),
  note text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table realization_company_aliases is 'Alternativní a historické názvy realizačních firem. Rows are deactivated, never deleted.';
comment on column realization_company_aliases.normalized_alias is 'normalizeCompanyName(alias) from domain/realizationCompanyIdentity.ts — diacritics, legal suffixes and punctuation removed.';

create unique index realization_company_aliases_active_normalized_key on realization_company_aliases (normalized_alias) where is_active;
create index realization_company_aliases_company_idx on realization_company_aliases (realization_company_id);

create trigger realization_company_aliases_set_updated_at before update on realization_company_aliases for each row execute function set_updated_at();

create or replace function realization_company_aliases_prevent_delete() returns trigger as $$
begin
  raise exception 'Alternativní název firmy nelze smazat, lze ho jen deaktivovat.' using errcode = 'P0001';
end;
$$ language plpgsql;

create trigger realization_company_aliases_prevent_delete before delete on realization_company_aliases for each row execute function realization_company_aliases_prevent_delete();

-- =========================================================================
-- Old placeholder identifiers (decision A2 — recorded, not mapped)
-- =========================================================================
create table realization_company_legacy_ids (
  legacy_id text primary key,
  kind text not null check (kind in ('system_no_override', 'unresolved', 'mapped')),
  realization_company_id text references print_surface_realization_companies (id) on delete restrict,
  evidence text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint realization_company_legacy_ids_mapped_has_company check ((kind = 'mapped') = (realization_company_id is not null))
);

comment on table realization_company_legacy_ids is 'Old realization ids still stored in project documents (realizationProfileId), productionProfiles keys and legacy price lists / events. Resolved on read by resolveRealizationReference (domain/realizationCompanyIdentity.ts); stored documents are never rewritten.';

create trigger realization_company_legacy_ids_set_updated_at before update on realization_company_legacy_ids for each row execute function set_updated_at();

insert into realization_company_legacy_ids (legacy_id, kind, evidence) values
  ('default', 'system_no_override', 'Výchozí project.realizationProfileId (domain/project.ts) a realizationCompanyId veletrhů a ceníků v data/organizations.ts. Ve výrobní logice znamená „bez přepisu, výrobní rozměr = kanonický“. Není to firma (rozhodnutí A2).'),
  ('realization-2', 'unresolved', 'Zástupné ID „Realizačka 2“ z data/realizationProfiles.ts (commity 081e6a1, 7b0e927). Skutečná firma není doložena.'),
  ('realization-3', 'unresolved', 'Zástupné ID „Realizačka 3“ z data/realizationProfiles.ts (commity 081e6a1, 7b0e927). Skutečná firma není doložena.'),
  ('realization-4', 'unresolved', 'Zástupné ID „Realizačka 4“ z data/realizationProfiles.ts (commity 081e6a1, 7b0e927). Skutečná firma není doložena.');

-- A firm may never take an old placeholder id (e.g. an Excel header named "Default").
create or replace function realization_companies_prevent_legacy_id() returns trigger as $$
begin
  if exists (select 1 from realization_company_legacy_ids where legacy_id = new.id) then
    raise exception 'ID % je vyhrazené pro historický identifikátor, firma ho nesmí použít.', new.id using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger print_surface_realization_companies_prevent_legacy_id before insert on print_surface_realization_companies for each row execute function realization_companies_prevent_legacy_id();

-- =========================================================================
-- Shared interface for other modules (decision A9)
-- =========================================================================
create view realization_companies with (security_invoker = true) as
select
  id,
  name as display_name,
  legal_name,
  abra_name,
  ico,
  dic,
  contacts,
  note as internal_note,
  is_active,
  source,
  created_at,
  updated_at
from print_surface_realization_companies;

comment on view realization_companies is 'Neutral read interface over print_surface_realization_companies (decision A9). security_invoker: the base table''s RLS applies.';

-- Browser must never talk to Postgres directly — RLS with zero policies, same convention as every
-- other table; the server-only service-role client bypasses RLS by design.
alter table realization_company_aliases enable row level security;
alter table realization_company_legacy_ids enable row level security;
revoke all on realization_companies from anon, authenticated;
