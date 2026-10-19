-- Per-version reveal of map content.
--
-- `maps.revealed_at` is stamped once, when the map first locks inside a tournament, and is never
-- cleared. That cannot express "version 1 was revealed by tournament A while version 2 is still the
-- secret board of tournament B": after A reveals the map, the organizer could publish a new version
-- for B and every reader would see B's board before B locks. Hidden content is therefore gated per
-- version, and a version becomes public when the tournament that pinned it locks.
ALTER TABLE map_versions ADD COLUMN revealed_at TIMESTAMPTZ;

-- Existing reveals were map-level. Treating every version of an already-revealed map as revealed is
-- the least surprising backfill for a database that predates version-level gating: it never reveals
-- anything the previous build was already serving.
UPDATE map_versions v
   SET revealed_at = m.revealed_at
  FROM maps m
 WHERE m.id = v.map_id AND m.revealed_at IS NOT NULL;

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (23, '023-map-version-reveal')
ON CONFLICT (version) DO NOTHING;
