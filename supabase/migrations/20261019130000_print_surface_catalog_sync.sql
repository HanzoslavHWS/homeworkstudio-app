-- V1-DATA-02 (M4) — safe print-surface catalog sync (design B1, docs/DEV_DATA_IMPORT_PLAN.md).
--
-- Replaces the old client-side delete-then-insert of firms, presets and production dimensions.
-- One function call = one transaction: everything is written, or nothing is.
--   - Firms: inserted when new; an existing firm card is never overwritten (ON CONFLICT DO NOTHING).
--   - Presets and production dimensions: upserted; rows the file does not mention are kept.
--   - Nothing is deleted. Deactivation happens only for the ids the caller passes explicitly, and
--     for firms only when they were created by an import (source = 'import').
-- The plan (which header maps to which firm, what is new, what changes) is computed and shown as a
-- preview by domain/printSurfaceCatalogSync.ts before this function is called.

create or replace function sync_print_surface_catalog(
  p_companies jsonb,
  p_presets jsonb,
  p_dimensions jsonb,
  p_deactivate_company_ids text[] default '{}',
  p_deactivate_preset_ids text[] default '{}'
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_companies_created integer;
  v_presets_written integer;
  v_dimensions_written integer;
  v_companies_deactivated integer;
  v_presets_deactivated integer;
begin
  if jsonb_typeof(p_companies) <> 'array' or jsonb_typeof(p_presets) <> 'array' or jsonb_typeof(p_dimensions) <> 'array' then
    raise exception 'sync_print_surface_catalog: p_companies, p_presets a p_dimensions musí být pole.' using errcode = '22023';
  end if;

  insert into print_surface_realization_companies (id, name, source)
  select company ->> 'id', company ->> 'name', 'import'
  from jsonb_array_elements(p_companies) as company
  on conflict (id) do nothing;
  get diagnostics v_companies_created = row_count;

  insert into print_surface_presets as target (id, type_id, name, description, is_active, parent_id, parent_name)
  select
    preset ->> 'id',
    preset ->> 'typeId',
    preset ->> 'name',
    preset ->> 'description',
    coalesce((preset ->> 'isActive')::boolean, true),
    preset ->> 'parentId',
    preset ->> 'parentName'
  from jsonb_array_elements(p_presets) as preset
  on conflict (id) do update set
    type_id = excluded.type_id,
    name = excluded.name,
    description = excluded.description,
    is_active = excluded.is_active,
    parent_id = excluded.parent_id,
    parent_name = excluded.parent_name
  where (target.type_id, target.name, target.description, target.is_active, target.parent_id, target.parent_name)
    is distinct from (excluded.type_id, excluded.name, excluded.description, excluded.is_active, excluded.parent_id, excluded.parent_name);
  get diagnostics v_presets_written = row_count;

  insert into print_surface_production_dimensions as target (realization_company_id, preset_id, status, width_mm, height_mm, note)
  select
    dimension ->> 'realizationCompanyId',
    dimension ->> 'presetId',
    dimension ->> 'status',
    case when dimension ->> 'status' = 'available' then (dimension ->> 'widthMm')::integer end,
    case when dimension ->> 'status' = 'available' then (dimension ->> 'heightMm')::integer end,
    dimension ->> 'note'
  from jsonb_array_elements(p_dimensions) as dimension
  on conflict (realization_company_id, preset_id) do update set
    status = excluded.status,
    width_mm = excluded.width_mm,
    height_mm = excluded.height_mm,
    note = excluded.note
  where (target.status, target.width_mm, target.height_mm, target.note)
    is distinct from (excluded.status, excluded.width_mm, excluded.height_mm, excluded.note);
  get diagnostics v_dimensions_written = row_count;

  update print_surface_realization_companies
  set is_active = false
  where id = any(p_deactivate_company_ids) and source = 'import' and is_active;
  get diagnostics v_companies_deactivated = row_count;

  update print_surface_presets
  set is_active = false
  where id = any(p_deactivate_preset_ids) and is_active;
  get diagnostics v_presets_deactivated = row_count;

  return jsonb_build_object(
    'companiesCreated', v_companies_created,
    'presetsWritten', v_presets_written,
    'dimensionsWritten', v_dimensions_written,
    'companiesDeactivated', v_companies_deactivated,
    'presetsDeactivated', v_presets_deactivated
  );
end;
$$;

comment on function sync_print_surface_catalog(jsonb, jsonb, jsonb, text[], text[]) is 'B1: non-destructive, transactional print-surface catalog sync. Called only by the server (service role) after a preview — see lib/printSurfaces/printSurfaceCatalogSyncApi.server.ts.';

-- Server-only, like every table here: not callable with the browser (anon/authenticated) keys.
revoke all on function sync_print_surface_catalog(jsonb, jsonb, jsonb, text[], text[]) from public, anon, authenticated;
grant execute on function sync_print_surface_catalog(jsonb, jsonb, jsonb, text[], text[]) to service_role;
