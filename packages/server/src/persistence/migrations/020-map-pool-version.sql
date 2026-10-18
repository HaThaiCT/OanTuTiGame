-- S08: the tournament map pool pins a version per map. 02-GAMEPLAY §153 requires the pool order and
-- digests to be fixed before registration and the resolved artifacts frozen at lock, so the pool row
-- carries the version the tournament will actually play (a later publish of the same map must not
-- change a frozen tournament).
ALTER TABLE tournament_map_pool ADD COLUMN IF NOT EXISTS map_version INTEGER;

UPDATE tournament_map_pool p
   SET map_version = m.current_version
  FROM maps m
 WHERE m.id = p.map_id
   AND p.map_version IS NULL;

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (20, '020-map-pool-version')
ON CONFLICT (version) DO NOTHING;
