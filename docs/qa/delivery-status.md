# Audit delivery status

## Repository snapshot

One requested status/branch/remotes collection returned clean status at collection time; branch `develop/online-v2-2`; origin fetch/push `https://github.com/HaThaiCT/OanTuTiGame.git`. Changes appearing since that snapshot include this workstream's explicitly authorized one-line rating fix and audit-document updates. Other agents' changes are user-owned and not reverted. No commit or push performed by this workstream.

Subsequent requested HEAD/log snapshot: HEAD `27b2a99abf0b0fd44a48f4001437d2b44e382066`; recent commits: `27b2a99 docs(qa): record browser and backend audit reports with verification evidence`; `54f5193 fix(web): preserve tournament returnTo on guest registration login CTA`; `8bd6bb1 test: isolate tournament lifecycle regression fixtures`; `7d0a060 fix: decouple starter bot seeds from fixture admins`; `7158f57 feat(ux): implement tournament-centered hub, codeforces-style news, starter bots, and rating 0`. Clean status was explained by an intervening audit-doc commit. This workstream did not create/amend it and preserves it.

## Scoped changes

- `packages/server/src/ratings/routes.ts`: actual string code guard prevents undefined overriding domain error codes.
- `QA_AUDIT_REPORT.md`: fresh backend evidence and Incomplete verdict, preserving historical test claims as historical.
- `docs/qa/2026-10-23-backend-audit.md`: baseline,28-case matrix, detailed HTTP expected/actual, setup errors, skipped prerequisites, red/green fix record.
- `docs/qa/2026-10-23-backend-evidence/`: default-suite setup/final logs, migrations/grants/probes, readiness, red/green gated results and sanitized HTTP receipts.
- `docs/qa/delivery-status.md`: this handoff summary.

## Evidence

- Pre-fix fresh default suite: exit0,120 files passed/5 skipped;734 tests passed/43 skipped (`final-sanitized`).
- Formerly skipped five suites: initial exit1,41 passed/1 failed; after authorized minimal fix exit0,5 files/42 tests passed (`gated-suites-fixed`).
- Native HTTP fixed stale-cursor receipt:200 page with cursor→direct fixture publication generation replacement→409 RATING_PAGE_STALE (`rating-http-fixed.json`); not a claim of live game/rating computation.
- Isolated lifecycle HTTP receipts explicitly distinguish short-idempotency-key400 fixture error from valid lock replay;0eligible/1excluded and MAP_REQUIRED start rejection do not prove native worker execution.
- Post-fix reused-DB full run failed4 fixture setup suites due existing encounter/team FK dependencies (697 passed/80 skipped); retained post-fix/npm-test.log. Server TypeScript tsc --noEmit -p packages/server/tsconfig.json exited0. This polluted reused-DB run is not product acceptance; NEW clean DB full default run is recorded separately in post-fix-fresh/.
- Corrected post-fix NEW clean database run **exit0:120 files passed/5 skipped;734 tests passed/43 skipped** (`post-fix-fresh/npm-test.log`, exit.json). Five gated suites42/42 pass and server typecheck0 are independently recorded. Existing failing regression preserved unchanged.

## Runtime and safety

Prior own HTTP listener absent at read-only process inspection; no shared process stopped. Native smoke listener closed in finally. Own temporary credentials and HTTP scripts removed; earlier credential handoff path no longer available. No credential contents copied into repository. Test-only databases remain on test PostgreSQL15543, not shared demo. No applied SQL edits or shared preview mutations/restarts. Overall acceptance remains **Incomplete — sampled control-plane paths verified; not execution-ready or production-approved** due to readiness503/native/backup gates, missing demo checksum receipts31–32 and remaining browser/operator/AT coverage. UI contrast fix/verification owned separately by evidence-review.

Backend scoped fix/docs/evidence are ready for parent's review and commit authorization; no commit or push performed. Independent hygiene reviewer evidence-review.md read: sanitized evidence clean; current reviewer model receipt does not substantiate older withdrawn UI provenance. Overall release remains incomplete. Await separate UI worker verification and parent authorization before any scoped integration; preserve existing audit commit27b2a99 and all user-owned changes.
