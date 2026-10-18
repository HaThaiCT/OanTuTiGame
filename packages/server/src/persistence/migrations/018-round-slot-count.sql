-- Bracket width per round. EMPTY slots (02-GAMEPLAY §83/§122) mean a round can hold fewer encounter
-- rows than the structure has slots, so the structural count must be persisted for the next round's
-- pairing. 0 marks rounds written before this column existed (legacy fallback keeps array order).
ALTER TABLE tournament_rounds ADD COLUMN slot_count integer NOT NULL DEFAULT 0;
