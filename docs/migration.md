# Migration, updates, and backup

This file covers moving from file-based memory, updating an install, and backup and restore.

This file covers three things: moving from file-based memory into ira-memory, keeping an existing install up to date, and backing up and restoring the database.

## Migrating from file-based memory

ira-memory was built to run next to file-based memory (`MEMORY.md` and `memory/*.md`), not to replace it at once. The move happens in four phases:

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
5. Restarts the managed service so it loads the new code and the new `.env`. The script looks for a systemd user unit named `ira-memory-api.service` on Linux, and a launchd job named `com.ira.ira-memory-api` on macOS. If neither is found, the script prints a hint. Restart the server by hand with `bun run memory-api`.

   The unit files shipped in `deploy/` use different names: `ira-memory.service` for systemd and the launchd label `dev.ira-memory`. Rename the unit or label to match the script, or restart the server by hand.
6. Checks `/health` and a database-backed endpoint.

The script is safe to run again. Example unit files are in `deploy/systemd/ira-memory.service` and `deploy/launchd/dev.ira-memory.plist`. Both contain `/PATH/TO/ira-memory` placeholders you must replace.

## Backup and restore

Backups are plain `pg_dump` files.

```bash
bun run src/cli.ts backup
# writes backups/ira-memory-<timestamp>.sql

bun run src/cli.ts restore ./backups/ira-memory-2026-04-06T10-00-00-000Z.sql
```

Where the commands run:

- By default, `backup` and `restore` run `pg_dump` and `psql` inside this repo's `ira-memory-db` compose service, using `docker compose exec`. The database must be running.
- To use a different container, set `IRA_DB_CONTAINER` to its name. The commands then use `docker exec` on that container.
- The backup directory defaults to `backups/` in the repo. Set `IRA_BACKUP_DIR` to change it.

Backup files contain all your memory, including any sensitive facts. Keep them private. `backups/` and `*.dump` are in `.gitignore`.

### Backing up the sidecar

Entities and key-value data live in the SQLite sidecar, not in Postgres. `backup` does not copy it. Copy `~/.ira-memory/sidecar.db` yourself, or the legacy `~/.claude/memory-api-sidecar.db` if that is the file in use.

## Related

- [configuration.md](configuration.md#storage-paths): where the sidecar and backup directories live.
- [cli.md](cli.md#import-export-and-backup): the command reference.
