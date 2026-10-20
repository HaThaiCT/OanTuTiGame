# LAN software freeze receipt

Status: candidate receipt; freeze gate remains pending exact-SHA CI and independent review. `LAN_SOFTWARE_FROZEN` is reserved for the verified release snapshot.

## Snapshot and scope

- Intended maintenance branch: `release/lan-v2`.
- Exact snapshot SHA: assigned by the Git ref after the LAN commit; this receipt intentionally does not embed its own commit hash.
- Scope: LAN software behavior, build, regression verification, and maintenance handoff. No Online delivery feature, public deployment, tag, image publication, or infrastructure provisioning is included.
- Schema shipped by source: 27 (`EXPECTED_SCHEMA_VERSION`). Isolated test database observed before tests: `arena_rebuild_test`, schema version 27. The running demo database is a different database name and was not targeted by the test wrapper.
- Demo/runtime readiness is not represented as a release gate. Production readiness remains `false`; G0–G4 remain unsigned in the operational handover.
- U5: `PENDING_USER_ACCEPTANCE`.

## Verification evidence

- Regression RED: storage privacy test failed on env-root provenance, empty env handling, and independent replay/staging ownership.
- `node --import tsx deploy/linux/test-isolated.mts packages/server/tests/object-root-privacy.test.ts`: 6/6 passed after the change.
- Full `node --import tsx deploy/linux/test-isolated.mts`: 99 files passed, 4 skipped; 616 tests passed, 42 skipped. `tests/migrations-hardening.test.ts` skipped (10 tests) because the separate `OANTUTI_MIGRATION_TEST_URL` was not configured. Other skips: global rating publication/revisions and one format field-size case. Test logs contained auto-runner/reconciler fixture diagnostics; all tests completed successfully.
- `npx tsc --noEmit -p packages/server/tsconfig.json`: passed.
- `API_BASE=http://127.0.0.1:4301 npm run build --workspace=@oantuti/web`: passed (Next.js TypeScript phase completed; build command exited successfully).
- Browser smoke against existing portal: `/` loaded with title “OanTuTi Arena — Đấu trường thuật toán Búa Kéo Bao”; `/tournaments` rendered the tournament listing; `/rankings` rendered global team rankings. Read-only; no credentials or mutations used.
- Not run locally: `cargo test --workspace --tests --locked` (`cargo` unavailable), Compose configuration/image builds (Docker Compose plugin unavailable), final-image verifier smoke, and separate migration-hardening tests (no permitted migration-test URL configured). These are required in exact-SHA CI before freeze publication.
- Independent review: pending current-candidate reviewer result; no sign-off is claimed yet.
- Hosted CI run 39503085649 is for predecessor `71064d2`, not this candidate. Exact-SHA hosted CI remains required.
- Advisory disposition: see [dependency advisory disposition](dependency-advisory-disposition-2026-10-21.md); this receipt makes no stronger claim than that record.

- Read-only `/api/health/ready` observation: HTTP 503, `status=degraded`, `productionReady=false`, schema 27. Checks report no native gateway, unsandboxed development executor enabled, backup fence off, and workers not ready; no readiness guard was disabled to obtain this result.

## Operational boundary

This receipt is not `LAN_COMPLETE_STABLE`, production certification, or proof of host/sandbox safety. The operational gates remain G0–G4 `NOT_SIGNED`; sandbox on the release host, off-host backup, soak/rehearsal, and operational certification remain outstanding. No Online runtime, SMTP/provider, external mail delivery, or public commissioning is claimed.
