-- Adds the canonical P86 printable-surface registry: eight independently addressable panel
-- faces plus the existing fascia-print business id. FRONT/BACK are bound in each authored GLB
-- node's local component coordinates (-Y/+Y), never inferred from WORLD rotation or camera.
--
-- Runtime normalization remains in domain/boothAssets.ts for stale exports/backups. Targeting is
-- deliberately narrow and redundant; a missing P86 is a safe no-op and repeated runs do not
-- rewrite an identical JSONB value.

with canonical(surfaces) as (
  values ('[
    {"id":"back-wall-01-front","name":"Panel 1 FRONT","widthMm":950,"heightMm":2340,"orientation":"portrait","materialRole":"PRINT_SURFACE","active":true,"assignmentMode":"on-demand","group":{"id":"back-wall","name":"Zadní stěna","order":0},"order":0,"sceneBinding":{"nodeName":"HWS_PANEL_950_H2500__BACK_WALL_01__CORE","face":"front","coordinateSpace":"node-local","localNormalAxis":"-y"}},
    {"id":"back-wall-01-back","name":"Panel 1 BACK","widthMm":950,"heightMm":2340,"orientation":"portrait","materialRole":"PRINT_SURFACE","active":true,"assignmentMode":"on-demand","group":{"id":"back-wall","name":"Zadní stěna","order":0},"order":1,"sceneBinding":{"nodeName":"HWS_PANEL_950_H2500__BACK_WALL_01__CORE","face":"back","coordinateSpace":"node-local","localNormalAxis":"+y"}},
    {"id":"back-wall-02-front","name":"Panel 2 FRONT","widthMm":950,"heightMm":2340,"orientation":"portrait","materialRole":"PRINT_SURFACE","active":true,"assignmentMode":"on-demand","group":{"id":"back-wall","name":"Zadní stěna","order":0},"order":2,"sceneBinding":{"nodeName":"HWS_PANEL_950_H2500__BACK_WALL_02__CORE","face":"front","coordinateSpace":"node-local","localNormalAxis":"-y"}},
    {"id":"back-wall-02-back","name":"Panel 2 BACK","widthMm":950,"heightMm":2340,"orientation":"portrait","materialRole":"PRINT_SURFACE","active":true,"assignmentMode":"on-demand","group":{"id":"back-wall","name":"Zadní stěna","order":0},"order":3,"sceneBinding":{"nodeName":"HWS_PANEL_950_H2500__BACK_WALL_02__CORE","face":"back","coordinateSpace":"node-local","localNormalAxis":"+y"}},
    {"id":"left-wall-01-front","name":"Panel 1 FRONT","widthMm":950,"heightMm":2340,"orientation":"portrait","materialRole":"PRINT_SURFACE","active":true,"assignmentMode":"on-demand","group":{"id":"left-wall","name":"Levá stěna","order":1},"order":0,"sceneBinding":{"nodeName":"HWS_PANEL_950_H2500__LEFT_WALL_01__CORE","face":"front","coordinateSpace":"node-local","localNormalAxis":"-y"}},
    {"id":"left-wall-01-back","name":"Panel 1 BACK","widthMm":950,"heightMm":2340,"orientation":"portrait","materialRole":"PRINT_SURFACE","active":true,"assignmentMode":"on-demand","group":{"id":"left-wall","name":"Levá stěna","order":1},"order":1,"sceneBinding":{"nodeName":"HWS_PANEL_950_H2500__LEFT_WALL_01__CORE","face":"back","coordinateSpace":"node-local","localNormalAxis":"+y"}},
    {"id":"right-wall-01-front","name":"Panel 1 FRONT","widthMm":950,"heightMm":2340,"orientation":"portrait","materialRole":"PRINT_SURFACE","active":true,"assignmentMode":"on-demand","group":{"id":"right-wall","name":"Pravá stěna","order":2},"order":0,"sceneBinding":{"nodeName":"HWS_PANEL_950_H2500__RIGHT_WALL_01__CORE","face":"front","coordinateSpace":"node-local","localNormalAxis":"-y"}},
    {"id":"right-wall-01-back","name":"Panel 1 BACK","widthMm":950,"heightMm":2340,"orientation":"portrait","materialRole":"PRINT_SURFACE","active":true,"assignmentMode":"on-demand","group":{"id":"right-wall","name":"Pravá stěna","order":2},"order":1,"sceneBinding":{"nodeName":"HWS_PANEL_950_H2500__RIGHT_WALL_01__CORE","face":"back","coordinateSpace":"node-local","localNormalAxis":"+y"}},
    {"id":"fascia-print","name":"Límec","widthMm":2000,"heightMm":300,"orientation":"landscape","materialRole":"PRINT_SURFACE","allowanceLinearMeters":2,"pricingUnit":"bm","productionProfiles":{},"active":true,"group":{"id":"fascia","name":"Límec","order":3},"order":0,"sceneBinding":{"nodeName":"HWS_FASCIA_2000__FASCIA_01","face":"front","coordinateSpace":"node-local","localNormalAxis":"-y"}}
  ]'::jsonb)
)
update catalog_items
set document = jsonb_set(
  document,
  '{printSurfaces}',
  canonical.surfaces,
  true
)
from canonical
where kind = 'booth'
  and internal_code = 'P86'
  and document->>'id' = 'koje-2x2'
  and document->'printSurfaces' is distinct from canonical.surfaces;
