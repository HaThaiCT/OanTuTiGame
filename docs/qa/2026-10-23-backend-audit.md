# Backend runtime audit — 2026-10-23

## Baseline (06:40 UTC)

- HEAD `54f51939886355fecc9cfa586c3c705578ffc119`; initial status only untracked `docs/qa/`.
- Demo server image ID `sha256:a306f6959b7b6c2d2669514b8457dfa5a87e1631418933a79a1c886fd2518594`.
- Repository and actual container `/app` hashes match for `app.ts` (`1ed27d9c998748a7550b64f0ccb9b157da1b4fdd57888b5cfd68cc4f92431417`) and `schema-version.ts` (`cfe029f2b64d17b7a630d631052f5652402174148add2080a7a4846164cb04a1`). This proves these two files only, not whole-image equivalence.
- HTTPS `https://localhost:14443/api/health/ready`: **503 degraded**, `productionReady:false`, accepts officialGame/build/privateTest all false. PostgreSQL reachable; schema 32 matches. No native execution gateway; development executor off; backup freshness not enforced. Correct readiness is not the tournaments HTTP-200 smoke.
- Read-only demo queries: schema_migrations has 001–032; migration_checksums has only 001–030. Therefore schema version alone does not demonstrate a complete checksum receipt. Do not rewrite applied SQL or silently baseline.
- Shared preview and demo data remain untouched. Test target will be a new `arena_audit_*test` database on test PostgreSQL TCP 15543 only.

## Detailed execution matrix

Each automated outcome is attributable to the fresh default `npm test` log, not inferred from an earlier run. Pending means not yet executed in this audit.

| ID | Case / input and assertion | Method / current status |
|---|---|---|
| B01 | Compare HEAD, working tree and deployed source hashes; explicitly bound equivalence | Baseline observed above |
| B02 | HTTPS readiness must distinguish availability from all three execution capabilities | Observed 503, all false |
| B03 | Compare schema registrations and checksum registrations without modifying demo | Observed 32 vs 30 |
| B04 | Fresh isolated DB applies migrations 001–032 and records every checksum | Pending migration receipt |
| B05 | Run default repository npm test, not server-only selection; record exit/counts/skips | Pending full log |
| B06 | Create each of four tournament formats; reject invalid format/name/limits | Default suite pending |
| B07 | Publish/open lifecycle; expectedVersion conflicts cannot change state | Default suite plus isolated HTTP pending |
| B08 | Verified student creates tournament-scoped team; membership isolation | Default suite plus isolated HTTP pending |
| B09 | Registration request remains pending until ADMIN review | Default suite plus isolated HTTP pending |
| B10 | Approve/reject protects role, version and capacity | Default suite plus isolated HTTP pending |
| B11 | Same idempotency key/body replays once; key/body mismatch rejects | Default suite plus isolated HTTP pending |
| B12 | Stale aggregate request rejects without mutation | Default suite plus isolated HTTP pending |
| B13 | Reauthentication gates sensitive ADMIN mutations | Default suite plus isolated HTTP pending |
| B14 | Guest public standings/results omit private replay/source fields | Default suite plus isolated HTTP pending |
| B15 | Student/non-admin official replay ACL denies access by policy | Default suite pending |
| B16 | Private test ACL isolates owning team and official standings | Default suite pending |
| B17 | ZIP/source validation rejects traversal, malformed packages, quota excess | Default suite pending |
| B18 | Close/drain/lock freezes only eligible READY submissions | Default suite pending |
| B19 | Map commitment/version/pool gates deny invalid starts | Default suite pending |
| B20 | Four formats produce deterministic progression and valid verified results | Default suite pending |
| B21 | Appeals/adjudication enforce actor, window and aggregate constraints | Default suite pending |
| B22 | Rating publication requires explicit approved generation/digest | Default suite pending |
| B23 | Archive preserves history and checks state/reauth/idempotency | Default suite pending |
| B24 | Backup freshness/fence rejects unsafe execution when configured | Default suite pending; demo fence off |
| B25 | Native execution cannot be claimed without configured sandbox supervisor | Demo explicitly unavailable |
| B26 | Identity/origin/session controls distinguish allowed browser origin from hostile origin | Default suite pending |
| B27 | HTTP execution capability requests may safely reject without sandbox | Isolated HTTP pending |
| B28 | Enumerate every skip prerequisite, separate real native execution from mocks/test executors | Pending log/source skip inspection |

## Limits and verdict

No shared preview restart, native/dev enablement, SQL migration edits, or production commissioning. Real native sandbox and enforced off-host backup recovery are not certified by unit/service tests. Current baseline is control-plane available but production/execution **not ready**. Full fresh suite and isolated HTTP outcomes will be appended as observed.

## Executed HTTP cases and fixture prerequisites

Real TCP HTTP listener: `http://127.0.0.1:15601`, ONLINE profile, separate `arena_audit_http_20261023_test` PostgreSQL database; no native gateway and development executor disabled. This is an API listener only, not an independently deployed web UI. Private login credentials: `/tmp/oantuti-audit-http/credentials.json` (0600), intentionally not copied into repository evidence. Two verified accounts/password hashes were bootstrapped directly in this disposable database; subsequent login and all tournament/team/registration transitions below used real HTTP, not Fastify inject. Initial listener startup correctly rejected public object-root permissions; fixture directories were corrected to 0700. No production permission check was weakened.

Complete request payloads (passwords redacted), responses and expected statuses: [`2026-10-23-backend-evidence/http-receipts.json`](2026-10-23-backend-evidence/http-receipts.json). Tournament ID `67df8a1f-38ec-42bc-98b6-2cbfc11ecbda`. Below `T` denotes this ID, `R` registration `9103dd8d-a317-416b-9307-3fa8c8cb6c30`.

| Case | Preconditions and concrete steps | Expected versus actual / state evidence |
|---|---|---|
| B07 create | ADMIN login via `POST /api/v2/auth/login`; `POST /api/v2/organizer/tournaments` with courseCode AUDIT_HTTP, ROUND_ROBIN, min/max team size 1/3, maxTeams4, isRated false | Expected201 DRAFT; actual201 DRAFT. `POST /api/v2/organizer/tournaments/T/publish {}` actual200 PUBLISHED; `/open-registration {}` actual200 REGISTRATION_OPEN. |
| B08 create own team | Verified student login; `POST /api/v2/me/teams {tournamentId:T,name:"Audit HTTP team"}` during REGISTRATION_OPEN | Expected201 student captain, matching tournament; actual201, captainUserId matches authenticated student, rosterLocked false. |
| B09 request | Student captain; `POST /api/v2/tournaments/T/registrations {teamId:"7b6b33cb-3876-4109-b8eb-88e75074ac6f"}` | Expected201 PENDING v1; actual201 PENDING v1. No worker upload/build is claimed. |
| B10 role/review | `POST /api/v2/organizer/tournaments/T/registrations/R/review {decision:"APPROVE",expectedVersion:1}` as student then ADMIN | Expected student403, ADMIN200 APPROVED v2; actual403 FORBIDDEN then200 APPROVED v2. |
| B12 stale review | After approved v2, ADMIN posts REJECT, reason stale audit, expectedVersion1 to same review endpoint | Expected409 unchanged; actual409 STALE_VERSION; subsequent student GET confirms APPROVED v2. |
| B14 privacy/public | Guest GET `/api/v2/tournaments/T`; guest GET `/api/v2/tournaments/T/registrations`; student GET same registration list | Actual200 public REGISTRATION_OPEN detail;401 UNAUTHENTICATED private list;200 owning-student list containing APPROVED v2. This is not accepted-game replay/source sanitization coverage. |
| B13 reauth | ADMIN session with no recent reauth; `POST /api/v2/organizer/tournaments/T/close-registration {}`; `POST /api/v2/auth/reauth {password:[redacted]}`; retry close | Expected403 REAUTH_REQUIRED then reauth200/close200; all observed. State becomes VALIDATING_SUBMISSIONS. |
| B11 invalid-key fixture | ADMIN POST `/api/v2/organizer/tournaments/T/lock {}` with key audit-http-lock twice | Initial expectation200 was wrong: actual400 IDEMPOTENCY_KEY_INVALID (requires16–128 chars). This is an input/fixture error, not a product failure or successful replay. |
| B11 valid replay | Same lock route/body, changed key to audit-http-lock-valid-20261023 | Both actual200; exact same receiptId `59c781f9-6732-4acc-acd0-644a1ee75527` and timestamp. State READY_TO_START, eligibleTeamsCount0, excludedTeamsCount1. No direct READY state seed: lock naturally excludes admitted team with no READY source. This does not prove any worker build. |
| B12 stale lock | After close at version4, POST lock expectedVersion1, fresh key audit-http-stale | Actual409 STALE_VERSION: expected1/current4. Valid lock followed this request. |
| B27 start gate | ADMIN reauth; GET public state READY_TO_START, POST `/api/v2/organizer/tournaments/T/start {}`, GET again | Expected400 MAP_REQUIRED; actual400 MAP_REQUIRED and state remains READY_TO_START. Missing map is an earlier prerequisite: this request did NOT reach dispatch/gateway acceptance and is not proof of a native-execution gate. |
| B02 isolated readiness | GET `/api/health/ready` without session | Actual503, productionReady false, officialGame/build/privateTest false. This independently proves capabilities unavailable, not which later gate a valid start would reach. |

## Default repository suite attempts (not narrowed)

- Initial `arena_audit_20261023_0642_test` run was cancelled after connection setup errors: runtime PostgreSQL pool did not consume PGPASSWORD_FILE. Original `2026-10-23-backend-evidence/npm-test.log` retained as invalid setup evidence, not product failures.
- Credential-corrected fresh `arena_audit_20261023_0650_test` authenticated probe confirms database/user arena_app. Full `npm test` exited1: **118 files passed,2 failed,5 skipped;726 tests passed,8 failed,43 skipped**. Full stdout/stderr, exit metadata, migrations, grants and environment variable names are retained in `2026-10-23-backend-evidence/credential-corrected/`.
- Seven failures in `portable-demo-restore.test.ts` hit `PGPASSWORD_FILE must be a private regular file` before the intended restore assertions. The inherited external file path contaminated operator-fixture environments. One `online-mail-delivery.test.ts` case, `does not schedule a duplicate after SMTP accepted but delivery acknowledgement failed`, failed fixture DROP TRIGGER cleanup because arena_app did not own outbox_events. These are audit harness prerequisites, not demonstrated consumer defects. Secret policy and source remained unchanged.
- Final fresh `arena_audit_20261023_0653_test` run uses in-memory PGPASSWORD, removes PGPASSWORD_FILE from test subprocess environment, and grants only disposable outbox_events ownership for fixture DDL alongside disposable cleanup DML rights. Full default npm test is running; receipts are published immediately under `2026-10-23-backend-evidence/final-sanitized/`. No failures are excluded by test selection.

## Skip prerequisites and attribution limits

Five gated suites require `OANTUTI_MIGRATION_TEST_URL` (not supplied): `tests/migrations-hardening.test.ts`, `global-rating-placements-db.test.ts`, `global-rating-publication.test.ts`, `global-rating-revisions.test.ts`, `tournament-registration-migration.test.ts`. Therefore live rating publication/revision and migration-upgrade/checksum scenarios in those files are not claimed passed by this audit. Other conditional skips: `format-field-sizes.test.ts` avoids round2 cases when expected rounds≤1; `build-pipeline.test.ts` C++ case requires g++; `submission-quotas.test.ts` daily-cap case skips during first61 UTC minutes. Final aggregate skip count will be reported as observed, not fabricated by summing static test declarations.

Exact executable assertion examples (source attribution, not blanket acceptance): `replay-authorization.test.ts` → `requires FULL ADMIN before either official replay lookup, including missing targets`; `submission-quotas.test.ts` → `accepts 10 official receipts in the rolling hour and rejects the 11th with RECEIPTS_HOURLY`; `tournament-archive.test.ts` → `checks FULL ADMIN even when a completed receipt can be replayed`; `appeal-and-announcements.test.ts` → `blocks finalization while a dispute is open, even with a 0-minute window`; `backup-fence.test.ts` → `rejects missing, corrupt, extra, public and symlink objects`. Individual pass attribution is limited by the default reporter's aggregate successful-suite output; B06/B15–B26 above are scenario scope, not independently recorded real-HTTP successes.
