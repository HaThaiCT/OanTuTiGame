-- 031-tournament-centered-content.sql: News posts and admin starter bot templates

CREATE TABLE IF NOT EXISTS news_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0 AND length(title) <= 150),
  summary TEXT NOT NULL CHECK (length(btrim(summary)) > 0 AND length(summary) <= 500),
  content TEXT NOT NULL CHECK (length(btrim(content)) > 0 AND length(content) <= 50000),
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_news_posts_published ON news_posts(published_at DESC) WHERE state = 'PUBLISHED';
CREATE INDEX IF NOT EXISTS idx_news_posts_state ON news_posts(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS starter_bot_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 100),
  language TEXT NOT NULL CHECK (language IN ('PYTHON', 'TYPESCRIPT', 'CPP')),
  entrypoint TEXT NOT NULL,
  description TEXT CHECK (description IS NULL OR length(description) <= 1000),
  source_digest TEXT NOT NULL REFERENCES submission_sources(digest) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

GRANT ALL ON TABLE news_posts TO arena_app;
GRANT ALL ON TABLE starter_bot_templates TO arena_app;

CREATE INDEX IF NOT EXISTS idx_starter_bot_templates_active ON starter_bot_templates(is_active, language);

INSERT INTO schema_migrations(version, name) VALUES (31, '031-tournament-centered-content') ON CONFLICT (version) DO NOTHING;
