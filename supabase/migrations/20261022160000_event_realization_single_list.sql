-- V1-DATA-06 correction — one list of realization firms per event (docs/V1_DATA_DECISIONS.md 9.1).
--
-- The firm that builds a stand also handles its graphics and the electrical work inside it; the
-- main power supply belongs to the venue. An event therefore needs ONE list of realization firms
-- with one optional default (a suggestion for new tasks), not roles.
--
-- Non-destructive: no row is deleted and the role column stays. Every link is kept as history.
--   1. An active link in another role whose firm has no active link in the list becomes a list link
--      (an inactive list link is reactivated).
--   2. An event without a default keeps the default of its other roles (first role alphabetically).
--   3. Active links in other roles are then deactivated (still stored, readable as history).
--   4. From now on only list links ('construction') may be active.
-- save_event_realization_companies() is unchanged; the API always writes role 'construction'.

insert into event_realization_companies (event_id, realization_company_id, role, is_default, is_active, note)
select distinct on (other.event_id, other.realization_company_id)
  other.event_id, other.realization_company_id, 'construction', false, true, other.note
from event_realization_companies other
where other.is_active and other.role <> 'construction'
  and not exists (
    select 1 from event_realization_companies list
    where list.event_id = other.event_id and list.realization_company_id = other.realization_company_id and list.role = 'construction' and list.is_active
  )
order by other.event_id, other.realization_company_id, other.role
on conflict (event_id, realization_company_id, role) do update set is_active = true;

update event_realization_companies list
set is_default = true
from (
  select distinct on (other.event_id) other.event_id, other.realization_company_id
  from event_realization_companies other
  where other.is_active and other.is_default and other.role <> 'construction'
  order by other.event_id, other.role
) carried
where list.event_id = carried.event_id
  and list.realization_company_id = carried.realization_company_id
  and list.role = 'construction'
  and list.is_active
  and not exists (
    select 1 from event_realization_companies current_default
    where current_default.event_id = list.event_id and current_default.role = 'construction' and current_default.is_active and current_default.is_default
  );

update event_realization_companies set is_active = false, is_default = false where is_active and role <> 'construction';

alter table event_realization_companies add constraint event_realization_companies_single_list check (role = 'construction' or not is_active);

comment on table event_realization_companies is 'Realization firms of an event: ONE list (role = construction) with at most one active default — a suggestion for new tasks, never an automatic assignment of stands. Links of other roles exist only as inactive history from before the 2026-10-22 simplification. Removed links are deactivated, never deleted. Does not replace the legacy events.document.realizationCompanyId.';
comment on column event_realization_companies.role is 'Always construction for active links (= the firm realizing stands, including their graphics and in-stand electrical work). Other values only on inactive history rows.';
