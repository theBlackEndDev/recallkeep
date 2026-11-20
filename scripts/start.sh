#!/usr/bin/env bash
# Start everything ira-memory needs, then run the HTTP API in the foreground.
# Used by the launchd and systemd templates in deploy/, and fine to run by hand.
#
#   1. wait for Docker
#   2. start the Postgres container (docker compose up -d)
#   3. wait until Postgres accepts connections
#   4. apply any new database migrations
#   5. exec the API server (so the service manager sees its exit code)
set -euo pipefail

cd "$(dirname "$0")/.."
BUN="${IRA_BUN_PATH:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

until docker info >/dev/null 2>&1; do
  echo "[start] waiting for Docker..." >&2
  sleep 5
done

docker compose up -d

until docker compose exec -T ira-memory-db pg_isready -U ira_memory -d ira_memory >/dev/null 2>&1; do
  sleep 2
done

"$BUN" x prisma migrate deploy >/dev/null

exec "$BUN" run src/http-server.ts
