# Backend runtime audit — 2026-10-23

## Baseline (06:40 UTC)

- HEAD `54f51939886355fecc9cfa586c3c705578ffc119`; initial status only untracked `docs/qa/`.
- Demo server image ID `sha256:a306f6959b7b6c2d2669514b8457dfa5a87e1631418933a79a1c886fd2518594`.
- Repository and actual container `/app` hashes match for `app.ts` (`1ed27d9c998748a7550b64f0ccb9b157da1b4fdd57888b5cfd68cc4f92431417`) and `schema-version.ts` (`cfe029f2b64d17b7a630d631052f5652402174148add2080a7a4846164cb04a1`). This proves these two files only, not whole-image equivalence.
- HTTPS `https://localhost:14443/api/health/ready`: **503 degraded**, `productionReady:false`, accepts officialGame/build/privateTest all false. PostgreSQL reachable; schema 32 matches. No native execution gateway; development executor off; backup freshness not enforced. Correct readiness is not the tournaments HTTP-200 smoke.
- Read-only demo queries: schema_migrations has 001–032; migration_checksums has only 001–030. Therefore schema version alone does not demonstrate a complete checksum receipt. Do not rewrite applied SQL or silently baseline.
- Shared preview and demo data remain untouched. Test target will be a new `arena_audit_*test` database on test PostgreSQL TCP 15543 only.

## Detailed execution matrix

The initial scenario charter below is now reconciled against real HTTP receipts and the fresh default suite. Aggregate automated success is not a substitute for independently recorded endpoint or native execution coverage.

| ID | Case / input and assertion | Method / current status |
|---|---|---|
| B01 | Compare HEAD, working tree and deployed source hashes; explicitly bound equivalence | Baseline observed above |
| B02 | HTTPS readiness must distinguish availability from all three execution capabilities | Observed 503, all false |
| B03 | Compare schema registrations and checksum registrations without modifying demo | Observed 32 vs 30 |
| B04 | Fresh isolated DB applies migrations 001–032 | Final migration log ends schema32/apply complete; no demo migration applied |
| B05 | Default repository npm test, no test exclusion | Exit0;120 files passed/5 skipped;734 tests passed/43 skipped; final-sanitized receipts |
| B06 | Four-format creation/invalid inputs | ROUND_ROBIN real HTTP201; other creation/invalid limit variants not independently exercised over HTTP |
| B07 | Publish/open lifecycle | HTTP201 DRAFT→200 PUBLISHED→200 REGISTRATION_OPEN; detailed endpoint table below |
| B08 | Verified student tournament-scoped team | HTTP201, matching tournament and captainUserId; additional membership isolation not independently exercised |
| B09 | Request remains pending before ADMIN review | HTTP201 PENDING version1; subsequent approve produces APPROVED version2 |
| B10 | Approve protects role/version | Student review403; ADMIN200; stale review409. Capacity race is not real-HTTP coverage here |
| B11 | Replay same key/body once | First invalid short key400 fixture error; valid key produces identical receipt twice. Changed-body reuse not independently exercised |
| B12 | Stale requests leave state unchanged | Review409 then GET APPROVED v2; lock expected1/current4 returns409 |
| B13 | Sensitive ADMIN reauth | Close403 REAUTH_REQUIRED→reauth200→close200 VALIDATING_SUBMISSIONS |
| B14 | Public/private ACL | Guest detail200/private registrations401; owner list200. Accepted-result replay/source sanitization not independently exercised |
| B15 | Official replay authorization | Automated source: replay-authorization.test.ts, requires FULL ADMIN before either official replay lookup, including missing targets; aggregate suite passed, no separate HTTP replay receipt |
| B16 | Private tests isolate team/official state | ONLINE registration suite assertion creates one durable pending request, freezes its roster, and grants no intake access; pending-team official/private intake denied in test. No live worker test |
| B17 | Submission quota | submission-quotas.test.ts, accepts 10 official receipts in the rolling hour and rejects the 11th with RECEIPTS_HOURLY; aggregate pass. No HTTP ZIP validation attempt |
| B18 | Lock selects READY source | tournament-lifecycle.test.ts, locks intake, selects latest valid submission by receipt ordinal, reveals hidden maps; service fixtures, not real compiler. HTTP lock had0 eligible/1 excluded |
| B19 | Map commitment start gate | map-versions.test.ts, uses the committed version descriptor and rejects a mismatched slug; aggregate pass. HTTP start400 MAP_REQUIRED, unchanged READY_TO_START |
| B20 | Series scheduling | four-formats.test.ts, gives the four games of a series four distinct map versions from the pool; aggregate pass. No native official games run |
| B21 | Appeals/finalize gate | appeal-and-announcements.test.ts, blocks finalization while a dispute is open, even with a 0-minute window; aggregate pass, no separate HTTP appeal |
| B22 | Rating publication/revision | Default gated suites skipped; dedicated five-suite execution receipt appended separately below |
| B23 | Archive role/version policy | tournament-archive.test.ts, checks FULL ADMIN even when a completed receipt can be replayed; aggregate pass, no HTTP archive |
| B24 | Backup integrity | backup-fence.test.ts, rejects missing, corrupt, extra, public and symlink objects; aggregate pass. Demo backup fence remains off; off-host restore not certified |
| B25 | Native dispatch | Readiness503/no gateway; no native certification or actual worker-backed accepted game |
| B26 | Origin/session | Same-origin HTTP login200; hostile origin not independently exercised in this HTTP run |
| B27 | Start prerequisite rejection | Exact400 MAP_REQUIRED before and after READY_TO_START; execution gateway branch not reached |
| B28 | Skip prerequisites | Default43 skips; five OANTUTI_MIGRATION_TEST_URL suites now separately executed; conditional skips documented below |

## Limits and verdict

No shared preview restart, native/dev enablement, SQL migration edits, or production commissioning. **Incomplete — sampled control-plane paths verified; not execution-ready or production-approved.** Automated/service tests do not certify real native sandbox operation or enforced off-host backup recovery.

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
- Final fresh `arena_audit_20261023_0653_test` uses in-memory PGPASSWORD, removes PGPASSWORD_FILE from test subprocess environment, and grants only disposable outbox_events ownership for fixture DDL alongside disposable cleanup DML rights. Full default `npm test` **exited0:120 files passed,5 skipped;734 tests passed,43 skipped**. Complete log and exit JSON under `2026-10-23-backend-evidence/final-sanitized/`. No failures excluded by test selection; no source changed.

## Skip prerequisites and attribution limits

Five suites were skipped in the default run because OANTUTI_MIGRATION_TEST_URL was initially absent: tests/migrations-hardening.test.ts, global-rating-placements-db.test.ts, global-rating-publication.test.ts, global-rating-revisions.test.ts, tournament-registration-migration.test.ts. Their contracts require the isolated cluster admin /postgres URL and create/drop their own new test databases. The available test-container owner secret permits a separate safe run, now captured in gated-suites receipts (not demo). Other conditional skips: format-field-sizes.test.ts avoids round2 when expected rounds≤1; build-pipeline.test.ts C++ requires g++; submission-quotas.test.ts daily cap skips in first61 UTC minutes. The default aggregate43 skips is observed; it must not be relabelled as43 unavoidable skips or added to dedicated pass counts without accounting for overlap.

Exact executable assertion examples (source attribution, not blanket acceptance): `replay-authorization.test.ts` → `requires FULL ADMIN before either official replay lookup, including missing targets`; `submission-quotas.test.ts` → `accepts 10 official receipts in the rolling hour and rejects the 11th with RECEIPTS_HOURLY`; `tournament-archive.test.ts` → `checks FULL ADMIN even when a completed receipt can be replayed`; `appeal-and-announcements.test.ts` → `blocks finalization while a dispute is open, even with a 0-minute window`; `backup-fence.test.ts` → `rejects missing, corrupt, extra, public and symlink objects`. Individual pass attribution is limited by the default reporter's aggregate successful-suite output; B06/B15–B26 above are scenario scope, not independently recorded real-HTTP successes.

## Confirmed backend defect, minimal fix and retest

The dedicated five-suite run initially exited1: **4 files passed,1 failed;41 tests passed,1 failed**, with no skips. See `2026-10-23-backend-evidence/gated-suites/`. `global-rating-publication.test.ts` → `approves once, replays the decision idempotently, and rebuilds rows after rejection and reopen` failed at line331: stale leaderboard cursor returned409 but error code literal `undefined`, expected `RATING_PAGE_STALE`.

Root cause: `ratings/routes.ts` coerced an existing-but-undefined error.code to the truthy string `undefined`, overriding the domain-code fallback. The minimal authorized non-UI fix accepts only actual string code values; empty string still falls through. Actual PostgreSQL/transport string codes and existing database-unavailable classification remain unchanged. The existing regression assertions were preserved, not weakened or re-pinned.

After the fix, the **same five gated suites passed5 files/42 tests, exit0**, `gated-suites-fixed/vitest.log` and `exit.json`. This includes the publication test `returns service unavailable rather than an empty leaderboard for database failures`, exercising the preserved unavailable response contract. Separate native HTTP smoke (`rating-http-fixed.json`) used TCP loopback and real rating routes/services: seeded two-team publication generation, GET leaderboard200 with real nextCursor, replaced active publication generation in the isolated HTTP fixture, GET old cursor409 `{code:"RATING_PAGE_STALE",message:"RATING_PAGE_STALE"}`. Fixture generations were directly seeded; this smoke does not claim to calculate ratings or execute games. The full publication/regeneration service path is covered by the now-green gated regression.

### Change record

- Fixed stale rating pagination error-code serialization in `packages/server/src/ratings/routes.ts` without changing authorization, database failure policy, migrations or UI.
- Gated upgrade/checksum/rating scenarios are now executed, not unavailable prerequisites. Default43 skips included42 gated tests plus one conditional case; retain separate receipts rather than add overlapping suite totals blindly.
- Post-fix fresh full default npm test **exit0:120 files passed,5 skipped;734 tests passed,43 skipped** on arena_audit_postfix_20261026_test, `post-fix-fresh/npm-test.log` and `exit.json`. Server typecheck **exit0**, `post-fix/server-typecheck.log` and `exit.json`. The separate gated **42/42 pass** supplies the42 default URL-gated cases; remaining one conditional default skip is not a missing executable migration suite. No claims of native sandbox or production acceptance follow from these test results.

Post-fix verification attempt on the previously used734-pass database was setup-contaminated:4 suites failed before cases because retained encounters prevented broad teams/tournament fixture cleanup;697 tests passed/80 skipped, exit1. Exact files: identity-production.test.ts, submission-lifecycle.test.ts, submission-quotas.test.ts, teams.test.ts. See post-fix/npm-test.log. This is retained, not hidden or classified as a rating-route regression. Server typecheck exited0 in post-fix/exit.json. Corrected acceptance uses a NEW clean arena_audit_postfix_20261026_test database (post-fix-fresh/), with the same isolated test grants and full default command.

Evidence timestamps span the retained2026-10-23 audit and current resumed execution timestamps in exit JSON. Folder date labels identify the audit workstream, not a claim that all commands ran on the original date. Prior HTTP listener was absent at cleanup inspection; temporary HTTP credentials/scripts removed; native regression listener closed in finally. No shared stack restart or mutations.

## Final backend handoff

Backend regression fixed and verified: fresh default734 passed/43 skipped, five gated42 passed, server typecheck0, native HTTP stale-cursor409 correct. Source change is solely ratings/routes.ts error-code normalization; no tests re-pinned. Audit docs and sanitized evidence ready for parent's scoped review/commit authorization. Independent evidence-review.md reviewed: reports sanitized evidence clean and distinguishes unsupported historical model attribution from its own current-session model receipt. No commit or push by this worker.
