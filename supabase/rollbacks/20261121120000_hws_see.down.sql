-- Rollback of 20261121120000_hws_see.sql. Removes ONLY the HWS SEE objects (all data in them is
-- lost; R2 objects under the SEE prefix are NOT deleted by this script). Never run automatically.

drop function if exists see_record_view(uuid, uuid, text, boolean, integer);
drop table if exists see_events;
drop table if exists see_pin_attempts;
drop table if exists see_access_grants;
drop table if exists see_publications;
drop table if exists see_file_scene_links;
drop table if exists see_annotations;
drop table if exists see_scenes;
drop table if exists see_files;
drop table if exists see_projects;
