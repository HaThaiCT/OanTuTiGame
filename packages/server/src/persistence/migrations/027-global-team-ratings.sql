ALTER TABLE tournaments
  ADD COLUMN is_rated boolean NOT NULL DEFAULT false,
  ADD COLUMN global_rating_policy text NOT NULL DEFAULT 'ArenaContestRating/v1'
    CHECK (global_rating_policy = 'ArenaContestRating/v1');

ALTER TABLE tournament_entries
  ADD COLUMN global_rating_participant boolean NOT NULL DEFAULT false,
  ADD COLUMN global_rating_exclusion text
    CHECK (global_rating_exclusion IN ('PRESTART_EXCLUDED', 'WITHDRAWN', 'DISQUALIFIED'));

CREATE TABLE global_rating_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  desired_revision bigint NOT NULL DEFAULT 0 CHECK (desired_revision >= 0),
  active_revision bigint NOT NULL DEFAULT 0 CHECK (active_revision >= 0),
  active_generation bigint,
  next_publication_order bigint NOT NULL DEFAULT 1 CHECK (next_publication_order > 0)
);
INSERT INTO global_rating_control (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE global_rating_generations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  desired_revision bigint NOT NULL UNIQUE CHECK (desired_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE global_rating_contests (
  tournament_id uuid PRIMARY KEY REFERENCES tournaments(id) ON DELETE RESTRICT,
  tournament_name text NOT NULL,
  publication_order bigint UNIQUE CHECK (publication_order > 0),
  review_state text NOT NULL DEFAULT 'PENDING' CHECK (review_state IN ('PENDING', 'APPROVED', 'REJECTED')),
  desired_included boolean NOT NULL DEFAULT false,
  input_revision integer NOT NULL DEFAULT 0 CHECK (input_revision >= 0),
  placements jsonb,
  source_digest text CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  decision_reason text,
  policy text NOT NULL DEFAULT 'ArenaContestRating/v1' CHECK (policy = 'ArenaContestRating/v1'),
  CHECK (NOT desired_included OR (publication_order IS NOT NULL AND placements IS NOT NULL AND source_digest IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE global_rating_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
  input_revision integer NOT NULL CHECK (input_revision > 0),
  action text NOT NULL CHECK (action IN ('APPROVE', 'REJECT', 'REOPEN')),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tournament_name text NOT NULL,
  reason text,
  publication_order bigint,
  source_digest text CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  placements jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE global_rating_changes (
  generation_id bigint NOT NULL REFERENCES global_rating_generations(id) ON DELETE CASCADE,
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
  tournament_name text NOT NULL,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  publication_order bigint NOT NULL CHECK (publication_order > 0),
  input_revision integer NOT NULL CHECK (input_revision > 0),
  rank integer NOT NULL CHECK (rank > 0),
  rank_end integer NOT NULL CHECK (rank_end >= rank),
  participant_count integer NOT NULL CHECK (participant_count >= rank_end),
  old_rating integer NOT NULL CHECK (old_rating BETWEEN 0 AND 8000),
  old_public_rating integer CHECK (old_public_rating BETWEEN 0 AND 8000),
  delta integer NOT NULL,
  new_rating integer NOT NULL CHECK (new_rating BETWEEN 0 AND 8000),
  policy text NOT NULL CHECK (policy = 'ArenaContestRating/v1'),
  PRIMARY KEY (generation_id, tournament_id, team_id)

);
CREATE TABLE global_team_ratings (
  generation_id bigint NOT NULL REFERENCES global_rating_generations(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  rating integer NOT NULL CHECK (rating BETWEEN 0 AND 8000),
  max_rating integer NOT NULL CHECK (max_rating BETWEEN 0 AND 8000),
  rated_contests integer NOT NULL CHECK (rated_contests > 0),
  last_publication_order bigint NOT NULL CHECK (last_publication_order > 0),
  PRIMARY KEY (generation_id, team_id)
);
CREATE INDEX idx_global_team_ratings_leaderboard ON global_team_ratings(generation_id, rating DESC, team_id);

ALTER TABLE global_rating_control DISABLE TRIGGER ALL;
ALTER TABLE global_rating_control ENABLE TRIGGER ALL;
CREATE TRIGGER backup_mutation_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON global_rating_control
  FOR EACH STATEMENT EXECUTE FUNCTION backup_mutation_barrier();
CREATE TRIGGER backup_mutation_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON global_rating_generations
  FOR EACH STATEMENT EXECUTE FUNCTION backup_mutation_barrier();
CREATE TRIGGER backup_mutation_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON global_rating_contests
  FOR EACH STATEMENT EXECUTE FUNCTION backup_mutation_barrier();
CREATE TRIGGER backup_mutation_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON global_rating_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION backup_mutation_barrier();
CREATE TRIGGER backup_mutation_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON global_rating_changes
  FOR EACH STATEMENT EXECUTE FUNCTION backup_mutation_barrier();
CREATE TRIGGER backup_mutation_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON global_team_ratings
  FOR EACH STATEMENT EXECUTE FUNCTION backup_mutation_barrier();

INSERT INTO schema_migrations (version, name) VALUES (27, '027-global-team-ratings') ON CONFLICT (version) DO NOTHING;
