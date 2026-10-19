# Portable v2 website deployment

Same Linux container package runs on a personal host or VPS. This is a web deployment, not a native app. The default listener is loopback; use an SSH tunnel on a VPS before public TLS is configured.

## Prerequisites
Docker Engine and Docker Compose v2, Linux x86_64, sufficient persistent disk. PostgreSQL and object storage use separate named volumes. The host still needs independent sandbox certification before enabling bot execution. Container Ubuntu/Alpine does not change the host kernel.

## Secrets and first start
Create two different random passwords in files OUTSIDE the checkout. Never commit them or pass passwords in Compose command lines. Export PG_OWNER_PASSWORD_FILE and PG_APP_PASSWORD_FILE to the absolute paths of those files. Local container users must be able to read the files; secure the enclosing directory from other host users.

```
export PG_OWNER_PASSWORD_FILE=/absolute/private/path/postgres-owner
export PG_APP_PASSWORD_FILE=/absolute/private/path/postgres-app
export WEB_PORT=3000
export PUBLIC_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
export OANTUTI_BACKUP_FENCE=off   # mandatory; use `enforce` once a verified checkpoint pipeline exists
docker compose config --quiet
docker compose up --build -d
```

Open http://127.0.0.1:3000. Next.js standalone serves pages, nginx proxies API/WebSocket to Fastify, and v2 authority is PostgreSQL (not legacy.sqlite). The v1 compatibility routes and their separate SQLite file are not part of a v2 deployment: the image always wires PostgreSQL, so those routes are not registered at all.

Empty-volume initialization installs the versioned v2 SQL schema under a non-login migration owner, records SHA-256 checksums for each migration, and atomically grants application DML without audit UPDATE/DELETE or schema/checksum writes. Initialization is NOT an update migration mechanism.

```
export OANTUTI_MIGRATE_CONFIRM=arena
docker compose --profile ops run --rm ops \
  deploy/linux/apply-migrations.mts --apply --grant-to arena_app
```

The `ops` service (profile `ops`) is the only container carrying the database owner secret; the API keeps the application role. For a genuinely empty database (no `schema_migrations`), `--apply` applies the complete migration chain and records checksums automatically, including migrations 017/018 after their schema probes.

An existing database with no checksum table or missing checksums for registered versions is legacy: `--status` is read-only and reports `BASELINE REQUIRED`; ordinary `--apply` refuses without changes. After a verified backup and manual review that the existing schema matches this migration history, explicitly attest current bytes for registered migration versions only:

```
export OANTUTI_MIGRATE_CONFIRM="$PGDATABASE"
docker compose --profile ops run --rm ops deploy/linux/apply-migrations.mts --apply --baseline --grant-to arena_app
```

`--baseline` transactionally fills absent checksum rows; it does not replace existing rows or replay migrations. Wrong existing hashes and unknown versions fail closed. Do not use it to bypass schema differences. Future `--apply` validates every recorded checksum before migration DDL; drift or an unknown/missing applied version fails closed. The applier holds a database-scoped advisory lock through probes, migrations, and grants. Never remove volumes to perform an upgrade. `docker compose down` preserves named volumes; do not use `down -v` on real data.

## Local LAN and VPS
The default deployment profile is LAN_OFFLINE. It has organizer-issued accounts and no self-registration/mail recovery. A VPS may run this same profile over a private tunnel. ONLINE mode requires a real mail transport, HTTPS, explicit public origins and the relevant acceptance checks; setting an environment variable alone does not deliver email.

For public hosting, place an HTTPS reverse proxy on the host in front of the loopback gateway, including WebSocket forwarding, preserve the public Host and configure the exact external origin. Do not expose PostgreSQL or the Fastify port. Public TLS and forwarded-protocol trust must be verified before credentials are entered from the Internet.

When a reverse proxy is in front of the API, name it so the per-client login throttle keeps working and so a client cannot choose its own throttle bucket:

```
export OANTUTI_TRUSTED_PROXIES=127.0.0.1      # the proxy address (or CIDR), comma-separated
```

Leave it unset when clients reach the API directly: the forwarded address is ignored unless its sender is named, and `nginx.conf` already forwards the client address on the API and WebSocket locations. Behind a proxy without this setting every client shares one address, so 30 failed logins from anywhere lock out all logins for 15 minutes.

A v2 deployment mounts the versioned API only: the v1 match/replay/bot routes and their separate SQLite session store are not registered at all when PostgreSQL is wired, so they answer 404 rather than sitting behind a guard. `OANTUTI_LEGACY_API=1` is meaningful only in the standalone SQLite application, which has no control-plane routes. LAN_OFFLINE accounts are issued by the organizer (`/api/v2/organizer/accounts/provision-lan` or bulk enrollment).

## Not production certified
The native Rust verifier is included in the server image, and the UID-bound supervisor/worker software exists; this package does not configure a native worker or certify its sandbox on a target host. Keep `OANTUTI_DEV_EXECUTION=0` for any real competition deployment: untrusted student code must never run inside the API. The current demo deliberately differs and is unsafe for untrusted Bot execution. HTTP health alone is not runtime or sandbox proof.

This record covers a prior Compose build; re-run the current server image build and verifier smoke before using a new image. The system Docker CLI may lack the Compose plugin; check the current host before using the commands above.

## Exercised on this host
- Built `oantuti-web:v2-local` (Next standalone) and `oantuti-server:v2-local` successfully with Docker.
- Separate disposable PostgreSQL initialized 37 public tables, checksums on, schema owned by arena_migrator; arena_app can insert users but cannot UPDATE audit_events.
- Isolated nginx gateway on 127.0.0.1:4390 served `/` and `/workspace` with HTTP 200, `/api/v2/tournaments` with 200, unauthenticated `/api/v2/auth/me` with 401. Admin bootstrap/login returned 200/FULL with session cookie; course creation returned 200 and tournament creation 201.
- Account persisted across PostgreSQL restart. Current API exits on the terminated pool connection; Compose's restart policy is required. Manually restarting the isolated API restored login and mutation success. This is not zero-downtime database recovery.
- Actual isolated Compose project `oantuti-package-compose`: `config --quiet` and `up -d --build` succeeded, PostgreSQL/server health checks passed; `/`, `/workspace`, `/api/v2/tournaments` returned 200 through gateway 127.0.0.1:4391. Compose server restart succeeded. This is local-host evidence only, not VPS certification.
- Image npm install reported dependency advisories; production-only audit on the host reported two low findings via Monaco/DOMPurify. Image includes development dependencies and needs dependency/runtime hardening before public release. No blanket `npm audit fix --force` was applied.
