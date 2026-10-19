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
exec node --import tsx packages/server/src/index.ts
