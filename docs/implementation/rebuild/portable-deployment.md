# Portable v2 website deployment

Same Linux container package runs on a personal host or VPS. This is a web deployment, not a native app. The default listener is loopback; use an SSH tunnel on a VPS before public TLS is configured.

## Prerequisites
Docker Engine and Docker Compose v2, Linux x86_64, sufficient persistent disk. PostgreSQL and object storage use separate named volumes. The host still needs independent sandbox certification before enabling bot execution. Container Ubuntu/Alpine does not change the host kernel.

## Secrets and first start
Create two different random passwords in files OUTSIDE the checkout. Never commit them or pass passwords in Compose command lines. Export PG_OWNER_PASSWORD_FILE and PG_APP_PASSWORD_FILE to the absolute paths of those files. Local container users must be able to read the files; secure the enclosing directory from other host users. Compose file-backed secret `uid`/`gid`/`mode` keys cannot remap bind-source permissions, so set them on the host: enclosing directory `0700`, password files `0444` (PostgreSQL runs as UID 999, Node as UID 1000 — mode `0600` owned by your host user makes first init fail closed with `Permission denied`).

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
The default deployment profile is LAN_OFFLINE. It has organizer-issued accounts and no self-registration/mail recovery. The Online overlay below is only controlled startup packaging and does not constitute public commissioning authorization.

For public hosting, place an HTTPS reverse proxy on the host in front of the loopback gateway, including WebSocket forwarding, preserve the public Host and configure the exact external origin. Do not expose PostgreSQL or the Fastify port. Public TLS and forwarded-protocol trust must be verified before credentials are entered from the Internet.

When a reverse proxy is in front of the API, name it so the per-client login throttle keeps working and so a client cannot choose its own throttle bucket:

```
export OANTUTI_TRUSTED_PROXIES=127.0.0.1      # the proxy address (or CIDR), comma-separated
```

Leave it unset when clients reach the API directly: the forwarded address is ignored unless its sender is named, and `nginx.conf` already forwards the client address on the API and WebSocket locations. Behind a proxy without this setting every client shares one address, so 30 failed logins from anywhere lock out all logins for 15 minutes.

A v2 deployment mounts the versioned API only: the v1 match/replay/bot routes and their separate SQLite session store are not registered at all when PostgreSQL is wired, so they answer 404 rather than sitting behind a guard. `OANTUTI_LEGACY_API=1` is meaningful only in the standalone SQLite application, which has no control-plane routes. LAN_OFFLINE accounts are issued by the organizer (`/api/v2/organizer/accounts/provision-lan` or bulk enrollment).

### Loading the exported Docker package

The Online software receipt may provide one `docker save` archive containing the server and web images. Verify the receipt’s SHA-256 before loading, then run the Compose overlay **without `--build`** so it uses the loaded default tags `oantuti-online-v2-server:local` and `oantuti-online-v2-web:local`:

```sh
archive=/path/to/online-v2-images.tar.gz
(cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256")
docker load --input "$archive"
docker image inspect oantuti-online-v2-server:local oantuti-online-v2-web:local
docker compose -f docker-compose.yml -f docker-compose.online.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.online.yml up -d
```

`docker-compose.yml` pins these local image names while retaining the Dockerfiles for an explicit source rebuild. If you retag images, set `OANTUTI_SERVER_IMAGE` and `OANTUTI_WEB_IMAGE` to the corresponding tags in the operator environment. The archive checksum detects transfer corruption; it is not a signature or proof of trusted provenance. Do not place private database/SMTP/keyring secrets in the archive or repository.

### Controlled ONLINE startup (not public commissioning)

The default Compose command remains `LAN_OFFLINE` with loopback binding. ONLINE is an explicit overlay and requires a real external HTTPS origin and reverse proxy; do not set the LAN `PUBLIC_ORIGINS` localhost values for ONLINE. The operator-managed proxy terminates TLS and forwards WebSocket traffic to the Compose gateway. Bind the gateway only to the proxy's private host interface (normally `127.0.0.1` for a same-host proxy); never publish PostgreSQL or port 3001.

The config loader requires `OANTUTI_AUTH_PROFILE=ONLINE`, `OANTUTI_PUBLIC_BASE_URL` to be exactly the HTTPS origin (scheme, host and optional port only), `OANTUTI_SMTP_HOST`, `OANTUTI_SMTP_PORT`, `OANTUTI_SMTP_TLS_MODE` (`implicit` or `starttls`), `OANTUTI_SMTP_USER`, `OANTUTI_MAIL_FROM`, `OANTUTI_MAIL_REPLY_TO`, and `OANTUTI_TRUST_PROXY` as the trusted proxy IP/CIDR list. Set `PUBLIC_ORIGINS` to the same exact origin. No localhost fallback is allowed in this overlay.

SMTP password and mail keyring are host files outside the checkout, not Compose environment values or image contents. File-backed Compose secrets preserve host ownership/mode: the server runs as UID 1000 (`node`), so provision each secret file owned by UID 1000 with mode `0600`, in a parent directory inaccessible to other host users (`0700`). The config loader rejects symlinks, non-regular files, wrong owner, group/other permissions, or files over 64 KiB. The keyring JSON has `{ "currentKeyId": "...", "keys": { "id": "base64-encoded-32-byte-key" } }`; keep the current key present for decryption of existing material. Never put secret contents in `.env`, command arguments, logs, repository, or container image.

Create the external SMTP password and keyring through the operator's approved secret-management procedure; set absolute paths and non-secret transport configuration in the operator environment. Example names (values are placeholders, not credentials):

```sh
export PG_OWNER_PASSWORD_FILE=/secure/path/pg-owner
export PG_APP_PASSWORD_FILE=/secure/path/pg-app
export SMTP_PASSWORD_FILE=/secure/path/smtp-password
export MAIL_KEYRING_FILE=/secure/path/mail-keyring.json
export OANTUTI_AUTH_PROFILE=ONLINE
export OANTUTI_PUBLIC_BASE_URL=https://arena.example.org
export PUBLIC_ORIGINS=https://arena.example.org
export OANTUTI_SMTP_HOST=smtp.example.org OANTUTI_SMTP_PORT=587 OANTUTI_SMTP_TLS_MODE=starttls
export OANTUTI_SMTP_USER=arena-mailer OANTUTI_MAIL_FROM=arena@example.org OANTUTI_MAIL_REPLY_TO=support@example.org
export OANTUTI_TRUST_PROXY=127.0.0.1
export OANTUTI_BOOTSTRAP_CONFIRM=arena OANTUTI_BOOTSTRAP_ADMIN_EMAIL=admin@example.org OANTUTI_ACCOUNT_CAPACITY=500
export OANTUTI_BACKUP_FENCE=off WEB_BIND=127.0.0.1 WEB_PORT=3000
docker compose -f docker-compose.yml -f docker-compose.online.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.online.yml run --rm --no-deps server node --import tsx deploy/linux/online-preflight.mts
```

The preflight runs the same strict ONLINE config loader used by the application and checks `schema_migrations` equals `EXPECTED_SCHEMA_VERSION`. It opens PostgreSQL read-only for this check, constructs no transport, and sends no message. A clean schema is established using the owner-only ops procedure above (`apply-migrations.mts --apply --grant-to arena_app`) and then this online preflight is run before starting the API. The first ADMIN is bootstrapped separately through the existing ops profile; do not expose bootstrap credentials through Compose environment or logs. Preflight is a configuration/schema check, not proof of mail delivery, TLS, proxy correctness, backup custody, or host security.
#### Bootstrap Online ADMIN and capacity

After migrations and preflight pass, set the exact database confirmation, a positive account capacity that includes the first ADMIN, and the approved initial mailbox. The `ops` profile now stages the owner, SMTP, and keyring secrets into per-process private `0600` files before invoking a CLI; it removes those copies when the command exits.

```sh
export OANTUTI_BOOTSTRAP_CONFIRM=arena
export OANTUTI_ACCOUNT_CAPACITY=500
export OANTUTI_BOOTSTRAP_ADMIN_EMAIL=admin@example.org
docker compose -f docker-compose.yml -f docker-compose.online.yml --profile ops run --rm -it ops deploy/linux/bootstrap-admin.mts first-admin
```

The capacity setting is inserted with the pending singleton ADMIN and audit event in one PostgreSQL transaction if absent. If already configured, `OANTUTI_ACCOUNT_CAPACITY` must match it. The generated password is printed once to the interactive terminal only. The account cannot sign in until the verification delivery is explicitly confirmed; after verification, the first login forces a permanent password change. The mail transport runs in the API service, never in the bootstrap command.

#### Online ADMIN mailbox recovery

Mailbox-loss recovery is a separate maintenance operation, not an HTTP endpoint. It requires the organization-approved handover record, reason, exact DB confirmation, the same single ADMIN row, and an explicitly authorized replacement mailbox. The operator must have host-root or Docker-daemon authority; when run through Compose, `--user 0:0` is container root and does not itself prove host authorization. Use an interactive terminal; the temporary password is emitted only to that terminal.

```sh
export OANTUTI_RECOVERY_CONFIRM=arena
docker compose -f docker-compose.yml -f docker-compose.online.yml --profile ops run --rm --user 0:0 -it ops deploy/linux/recover-admin.mts "mailbox lost; approved handover" "AUTH-REFERENCE" admin-new@example.org
```

Recovery preserves the singleton identity, clears mailbox verification, revokes sessions and pending identity tokens/deliveries, queues verification to the new address, and forces a password change. Do not use an unapproved address or skip the verification step. Never include passwords or tokens in command arguments.


Start only after a separate commissioning authorization and completion of relevant gates:

```sh
docker compose -f docker-compose.yml -f docker-compose.online.yml up --build -d
```

G0–G4 host/operational gates remain `NOT_SIGNED`; this configuration does not make `productionReady` true. TLS certificate lifecycle, exact proxy trust/address behavior, firewall, sandbox, off-host encrypted backups/restore, monitoring, incident response, and human acceptance remain operator evidence. No deployment or external SMTP/network call is performed by this software preflight.


## Not production certified
The native Rust verifier is included in the server image, and the UID-bound supervisor/worker software exists; this package does not configure a native worker or certify its sandbox on a target host. Keep `OANTUTI_DEV_EXECUTION=0` for any real competition deployment: untrusted student code must never run inside the API. The current demo deliberately differs and is unsafe for untrusted Bot execution. HTTP health alone is not runtime or sandbox proof.

This record covers a prior Compose build; re-run the current server image build and verifier smoke before using a new image. The system Docker CLI may lack the Compose plugin; check the current host before using the commands above.

## Exercised on this host
- Built `oantuti-web:v2-local` (Next standalone) and `oantuti-server:v2-local` successfully with Docker.
- Separate disposable PostgreSQL initialized 37 public tables, checksums on, schema owned by arena_migrator; arena_app can insert users but cannot UPDATE audit_events.
- Isolated nginx gateway on 127.0.0.1:4390 served `/` and `/workspace` with HTTP 200, `/api/v2/tournaments` with 200, unauthenticated `/api/v2/auth/me` with 401. Admin bootstrap/login returned 200/FULL with session cookie; course creation returned 200 and tournament creation 201.
- Account persisted across PostgreSQL restart. Current API exits on the terminated pool connection; Compose's restart policy is required. Manually restarting the isolated API restored login and mutation success. This is not zero-downtime database recovery.
- Actual isolated Compose project `oantuti-package-compose`: `config --quiet` and `up -d --build` succeeded, PostgreSQL/server health checks passed; `/`, `/workspace`, `/api/v2/tournaments` returned 200 through gateway 127.0.0.1:4391. Compose server restart succeeded. This is local-host evidence only, not VPS certification.
Historical server-image npm installation reported advisories; that does not establish that the shipped web image contains development dependencies. `Dockerfile.web` installs in the builder stage and copies the Next standalone output into a fresh `NODE_ENV=production` runtime stage. The 2026-10-21 advisory disposition records the remaining Monaco-vendored DOMPurify findings; this is not a public-release certification.
