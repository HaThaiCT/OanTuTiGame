#!/bin/sh
set -eu
if [ -z "${PGPASSWORD_FILE:-}" ] || [ ! -r "$PGPASSWORD_FILE" ]; then
  echo 'PGPASSWORD_FILE must name a readable application database secret' >&2
  exit 1
fi
PGPASSWORD=$(cat "$PGPASSWORD_FILE")
if [ -z "$PGPASSWORD" ]; then
  echo 'Application database secret must not be empty' >&2
  exit 1
fi
export PGPASSWORD

if [ -f "/app/deploy/demo-data/arena_objects.tar.gz" ] && [ -z "$(ls -A /app/storage/replays 2>/dev/null)" ]; then
  echo "Unpacking demo replays and bot submissions into /app/storage..."
  tar -xzf /app/deploy/demo-data/arena_objects.tar.gz -C /app/
  chmod -R 700 /app/storage/replays /app/storage/submissions 2>/dev/null || true
fi

exec node --import tsx packages/server/src/index.ts
