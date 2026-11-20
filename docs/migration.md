# Migration, updates, and backup

This file covers moving from file-based memory, updating an install, and backup and restore.

This file covers three things: moving from file-based memory into RecallKeep, keeping an existing install up to date, and backing up and restoring the database.

## Migrating from file-based memory

RecallKeep was built to run next to file-based memory (`MEMORY.md` and `memory/*.md`), not to replace it at once. The move happens in four phases:

| Phase | Files | Database |
|-------|-------|----------|
| 0: Coexist | Read and write | Write-only (messages and facts) |
| 1: Import | Read-only source | Facts imported from files |
| 2: Dual-write | Still written | Read first, file as fallback |
| 3: Database-primary | Read-only exports | Authoritative |

Import your existing memory with:

```bash
bun run src/cli.ts import --memory-md /path/to/MEMORY.md --daily-dir /path/to/memory/
```

Both flags are optional. Pass only the ones you have.

The import never changes or deletes your files. To roll back at any phase, stop using the database. The file-based memory is still intact.

### Field mapping

The HTTP API accepts the file-based memory `type` names and maps them to categories at the boundary:

| `type` | Category |
|--------|----------|
| `user` | `PREFERENCE` |
| `feedback` | `LESSON` |
| `project` | `PROJECT_STATE` |
| `reference` | `CONTEXT` |

See [api.md](api.md#memory-facts) for the full route.

## Updating an existing install

```bash
bun run update              # pull, install, migrate, restart, health check
bun run update -- --dry-run # print what would run, change nothing
```

The script does these steps in order:

1. Stops if there are uncommitted changes to tracked files. Commit or stash them first.
2. Runs `git pull --ff-only`. If the history has diverged, it stops and asks you to resolve it.
3. Runs `bun install`.
4. Runs `bunx prisma generate` and `bunx prisma migrate deploy`. If the database is not running, the migration step fails with a message. Start the database with `docker compose up -d`.
5. Restarts the managed service so it loads the new code and the new `.env`. The script looks for the unit named in `RECALLKEEP_SERVICE_NAME`, then for the systemd user unit `recallkeep.service` on Linux or the launchd job `dev.recallkeep` on macOS (the names from `deploy/`). If none is found, the script prints a hint. Restart the server by hand with `bun run memory-api`.

   The unit files shipped in `deploy/` use different names: `recallkeep.service` for systemd and the launchd label `dev.recallkeep`. Rename the unit or label to match the script, or restart the server by hand.
6. Checks `/health` and a database-backed endpoint.

The script is safe to run again. Example unit files are in `deploy/systemd/recallkeep.service` and `deploy/launchd/dev.recallkeep.plist`. Both contain `/PATH/TO/recallkeep` placeholders you must replace.

## Backup and restore

Backups are plain `pg_dump` files.

```bash
bun run src/cli.ts backup
# writes backups/recallkeep-<timestamp>.sql

bun run src/cli.ts restore ./backups/recallkeep-2026-04-06T10-00-00-000Z.sql
```

Where the commands run:

- By default, `backup` and `restore` run `pg_dump` and `psql` inside this repo's `db` compose service, using `docker compose exec`. The database must be running.
- To use a different container, set `RECALLKEEP_DB_CONTAINER` to its name. The commands then use `docker exec` on that container.
- The backup directory defaults to `backups/` in the repo. Set `RECALLKEEP_BACKUP_DIR` to change it.

Backup files contain all your memory, including any sensitive facts. Keep them private. `backups/` and `*.dump` are in `.gitignore`.

### Backing up the sidecar

Entities and key-value data live in the SQLite sidecar, not in Postgres. `backup` does not copy it. Copy `~/.recallkeep/sidecar.db` yourself, or the legacy `~/.claude/memory-api-sidecar.db` if that is the file in use.

## Upgrading from ira-memory

RecallKeep was called ira-memory before 2026-11-20. Everything that carried the old name changed, so an old install needs three things: new setting names, a new database, and a new service name. Your data moves with a dump and restore.

### What was renamed

| Before | Now |
|---|---|
| `IRA_*` settings, for example `IRA_LLM_PROVIDER` | `RECALLKEEP_*`, for example `RECALLKEEP_LLM_PROVIDER` |
| `MEMORY_DATABASE_URL` | `RECALLKEEP_DATABASE_URL` |
| `MEMORY_API_PORT`, `MEMORY_API_HOST` | `RECALLKEEP_API_PORT`, `RECALLKEEP_API_HOST` |
| Postgres database and user `ira_memory` | `recallkeep` |
| Compose service `ira-memory-db`, volume `ira-memory-db-data` | service `db`, volume `recallkeep-db-data`, project name `recallkeep` |
| Data folder `~/.ira-memory` | `~/.recallkeep` |
| launchd job `dev.ira-memory`, systemd unit `ira-memory.service` | `dev.recallkeep`, `recallkeep.service` |

The HTTP API, its port (7775) and its routes did not change. Hooks and extensions that call `http://127.0.0.1:7775` keep working. The one visible change is `GET /health`, which now reports `"backend": "recallkeep"`.

### Move your data

Docker names the volume after the compose project, so a new compose project starts with an empty database. Do not skip the restore.

1. Stop the API server so nothing writes during the copy.
2. Dump the old database without owners, because the role name changes:

   ```bash
   docker exec <old-container> pg_dump -U ira_memory -d ira_memory --no-owner --no-acl > ira-memory.sql
   ```

3. Stop the old container. Keep it and its volume until you have checked the new database.
4. Update `.env` to the new setting names. Use the new database URL from `.env.example`.
5. Start the new stack and restore into it:

   ```bash
   docker compose up -d
   docker compose exec -T db psql -U recallkeep -d recallkeep -v ON_ERROR_STOP=1 -q < ira-memory.sql
   bunx prisma generate
   bunx prisma migrate status    # should say the schema is up to date
   ```

6. Compare row counts in `sessions`, `messages`, `memory_facts`, `summaries` and the three `*_embeddings` tables between the old and new database. They must match.
7. Replace the old service with the one from `deploy/`, then remove the old container and volume when you are satisfied.

If something looks wrong, stop the new stack, start the old container, and put your old `.env` back. Nothing in the old database was changed.

## Related

- [configuration.md](configuration.md#storage-paths): where the sidecar and backup directories live.
- [cli.md](cli.md#import-export-and-backup): the command reference.
