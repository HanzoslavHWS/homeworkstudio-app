-- Replaces P86's legacy 80 mm visual collision profile with the physical inward footprint
-- measured from the authored production GLB: 40 mm posts centred 10 mm inside the nominal
-- 0..2000 footprint occupy 30 mm inside and 10 mm outside. Runtime normalization remains in
-- domain/boothAssets.ts as a compatibility guard for stale exports and backups.
--
-- Targeting is intentionally redundant and narrow. Missing P86 is a safe no-op; repeated runs
-- are no-ops because IS DISTINCT FROM prevents an identical JSONB rewrite.

with canonical(obstacles) as (
  values ('[
    {"id":"back-wall","x":0,"y":1970,"width":2000,"height":30},
    {"id":"left-wall","x":0,"y":1000,"width":30,"height":1000},
    {"id":"right-wall","x":1970,"y":1000,"width":30,"height":1000}
  ]'::jsonb)
)
update catalog_items
set document = jsonb_set(
  document,
  '{collisionObstacles}',
  canonical.obstacles,
  true
)
from canonical
where kind = 'booth'
  and internal_code = 'P86'
  and document->>'id' = 'koje-2x2'
  and document->'collisionObstacles' is distinct from canonical.obstacles;
