-- Repairs the one canonical P86 / Kóje 2×2 catalog document that was persisted while its
-- collision rectangles still used the old plan-like Y=0 convention. Runtime normalization
-- remains in domain/boothAssets.ts as a compatibility guard for stale exports/backups.
--
-- Targeting is intentionally redundant and narrow: catalog kind, unique internal_code, and the
-- legacy document id must all identify P86. Missing P86 is a safe no-op; a second run is also a
-- no-op because the final IS DISTINCT FROM predicate stops an identical rewrite.

with canonical(obstacles) as (
  values ('[
    {"id":"back-wall","x":0,"y":1920,"width":2000,"height":80},
    {"id":"left-wall","x":0,"y":1000,"width":80,"height":1000},
    {"id":"right-wall","x":1920,"y":1000,"width":80,"height":1000}
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
