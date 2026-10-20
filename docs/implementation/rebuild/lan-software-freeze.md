# LAN software freeze receipt

Status: `LAN_SOFTWARE_FROZEN` (verified software snapshot only; not an operational release).

## Snapshot and scope

- Intended maintenance branch: `release/lan-v2`.
- Exact snapshot SHA: `f051f17eea61a41c320077e8e342e8ccd63b2b7a` (`release/lan-v2`). The commit itself does not embed its own hash.
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
- Local-only limitations were covered by exact-SHA hosted CI: [run 39508121275](https://github.com/HaThaiCT/OanTuTiGame/actions/runs/39508121275) for `f051f17eea61a41c320077e8e342e8ccd63b2b7a` passed workspace tests, Rust workspace tests, server typecheck, isolated migrations, web production build, Compose validation, both image builds, and final server-image verifier smoke. Tag-only publication was skipped; no image was published.
- Independent scoped review: assessable diff review found no blocker or regression findings (reviewer confidence 0.79); scope was storage provenance, tests, CI, and freeze/docs, not a full-server security audit.
- Advisory disposition: see [dependency advisory disposition](dependency-advisory-disposition-2026-10-21.md); this receipt makes no stronger claim than that record.

- Read-only `/api/health/ready` observation: HTTP 503, `status=degraded`, `productionReady=false`, schema 27. Checks report no native gateway, unsandboxed development executor enabled, backup fence off, and workers not ready; no readiness guard was disabled to obtain this result.

## Operational boundary

This receipt is not `LAN_COMPLETE_STABLE`, production certification, or proof of host/sandbox safety. The operational gates remain G0–G4 `NOT_SIGNED`; sandbox on the release host, off-host backup, soak/rehearsal, and operational certification remain outstanding. No Online runtime, SMTP/provider, external mail delivery, or public commissioning is claimed.
