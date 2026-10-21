# Online v2 — software package receipt and commissioning hand-off

**Status:** software implementation and Docker images prepared; **not deployed, not publicly commissioned, and not certified for production**. This receipt documents the code and local artifacts on `develop/online-v2`, separate from LAN operation and G0–G4/U5 acceptance.

## Scope delivered

- Strict `ONLINE` configuration, profile-specific origin/cookie protections, mailbox verification, resend and password recovery, recent reauthentication, and verified email change.
- Encrypted durable identity-mail outbox, lease/retry/hold state, delivery eligibility checks and provider-neutral test seam. Production adapter uses verified TLS SMTP. LAN_OFFLINE keeps its no-SMTP path.
- Singleton ADMIN bootstrap/recovery and account-capacity transaction; secret-staging wrapper only dispatches bundled operator CLIs.
- Self-service Online teams/invitations/captain and roster lifecycle, tournament entry-code issue/rotation/revocation/redemption, and one-team-per-student-per-tournament enforcement.
- ONLINE account, verification, reset, team, and code browser surfaces; standalone Next build, Dockerfiles and explicit Online Compose overlay/runbook.
- Immutable SQL migrations 028–029; LAN engine/ledger/result/submission authority preserved.

## Source and Docker artifacts

- Online implementation commit `c32f6bce48dbb2c8518fc238f973f009ab47ad0c` passed hosted GitHub Actions run [39581183145](https://github.com/HaThaiCT/OanTuTiGame/actions/runs/39581183145): workspace tests/build and both Docker image jobs succeeded; the registry publish job was correctly skipped on a branch push. The final receipt/plan update will be a docs-only commit and must also pass CI on its exact SHA.
- Locally built Linux amd64 images: `oantuti-online-v2-server:local` (`sha256:fd07a9b353829c14d68348ccc32165f82043bbf070ea381ff3ab76adc08332ad`) and `oantuti-online-v2-web:local` (`sha256:c22c28fae7a1c1a30bf0aa852c810e8fdea1fdb39579bbcb7a1297c0af1c5e7b`).
- Combined `docker save` archive: `/home/ha-thai/.local/share/oantuti/online-v2-release/online-v2-images.tar.gz` (281 MiB); checksum file `online-v2-images.tar.gz.sha256`; SHA-256 `5dd6159727a138cd00ca24e1c7fde73dc1699a4aed7c1649d8696b24e63cdb1a`. `sha256sum -c` passed after rebuilding the server image with the final email-delivery fix. Images are local artifacts, not pushed to GHCR or another registry.
- Load the image archive on an authorized host, then follow [portable deployment — exported images and controlled Online startup](portable-deployment.md#loading-the-exported-docker-package). The archive checksum proves transfer integrity only, not image signature/provenance. Compose still requires Docker Compose v2.

## Verification evidence

| Check | Observed result |
|---|---|
| Fresh isolated schema | PostgreSQL database `arena_online_final_publish_test`, migrations 001–029 applied successfully; expected schema version 29. |
| Workspace JavaScript suite | Final `npm test` with CI migration-test URL: 110 files passed; 720 tests passed, 1 skipped (721 total) across `arena_online_final_publish_test` and the disposable PostgreSQL migration-test cluster. |
| Rust workspace | `cargo test --workspace --tests --locked`: 167 tests passed, run with the bundled Rust 1.99.0 and `protoc` 36.2 toolchains. |
| Server TypeScript | `npx tsc --noEmit -p packages/server/tsconfig.json`: passed. |
| Production Web build | `npm run build --workspace=@oantuti/web`: Next.js 16.4.2 build and TypeScript succeeded; Online routes were generated. |
| Docker builds | `Dockerfile.server` and `Dockerfile.web` both built and tagged with the image names above. The server image verifier rejected malformed `{}` with exit 2 and JSON `{"ok":false,"error":"INVALID_INPUT_JSON: missing field `manifest` at line 1 column 2"}`. |
| Dependency audit | `npm audit`: two **low** findings remain through Monaco 0.57.0’s declared/vendored DOMPurify 3.4.15. They are **waived, not fixed**. Independent review found Monaco’s current sanitizer call paths pass HTML strings, never enable `IN_PLACE`, and do not reach the advisory preconditions; see [advisory disposition](dependency-advisory-disposition-2026-10-21.md). Reassess on every Monaco upgrade. The server image’s production dependency install reported zero advisories. |
| Private browser journeys | Isolated PostgreSQL `arena_online_browser_test`, private storage roots, local HTTPS proxy and an in-memory recording mail transport (no external SMTP). Browser: register → explicit fragment-token verification (page load made no POST) → login → create team → redeem shared entry code (201) → reauthenticate and request email change → verify new address (session revoked; old-address notification delivery reached `DELIVERED` in DB) → password-reset request → explicit reset → login with new password. No demo DB/service was used. Final rebuilt Web separately served `/register` and returned `{authProfile:"ONLINE"}` through the HTTPS proxy. |
| Compose configuration | The workstation Docker CLI has no Compose v2 plugin (`docker compose` returned `unknown command`). Therefore no local Compose pass is claimed. CI is configured to run `docker compose config --quiet`, `docker compose --profile ops config --quiet`, and the layered Online overlay validation on the pushed SHA; use those hosted checks as the release gate. |

The browser smoke used fake `smtp.example.invalid` configuration and an injected recording transport. It did not contact a mail provider. Test tokens remained inside the private test harness and must not be reused.

## G0–G4 and U5: not signed

These are deployment/user acceptance gates, not results inferred from unit tests or image builds. `releaseReady` remains false; `productionReady` has not been established.

- **G0 — baseline/config:** software configuration and preflight exist, but actual deployment settings/secrets, origin, and target inventory are not supplied.
- **G1 — isolation/security:** Online authorization and token/mail boundaries are tested; this does not certify the target host’s gVisor/native worker isolation, no-network policy, watchdog/reaper or canaries. Do not execute untrusted Bot code in the API; keep `OANTUTI_DEV_EXECUTION=0`.
- **G2 — correctness/durability:** migrations and isolated lifecycle tests pass; target-host backup/restore, storage custody, and operational recovery remain unproven.
- **G3 — capacity/endurance:** no target workload measurements, 72-hour soak, seven-day rehearsal, or capacity claim is made.
- **G4 — operations:** no real TLS/domain/DNS/proxy review, provider/quota drill, encrypted off-host backup/restore, monitoring/incident exercise, or operator sign-off has been supplied.
- **U5 — human UX acceptance:** remains pending the product owner’s review and sign-off.

## Human-controlled deployment prerequisites

To proceed from the software package to controlled production commissioning, the authorized operator must supply/approve: target Linux/amd64 host and Docker Compose v2; exact public HTTPS origin/domain and TLS certificate/reverse-proxy IP/CIDR; approved SMTP host/port/TLS/user/password and verified sender/reply-to mailboxes; externally stored PostgreSQL owner/app password files and 32-byte mail-keyring custody/rotation plan; approved first ADMIN mailbox and positive account capacity; off-host encrypted backup destination, key escrow and successful restore evidence; host sandbox/runtime installation and isolation-canary results; monitoring/on-call/incident contacts; G0–G4 approvals and U5 acceptance.

No real email was sent, no external registry/tag was published, and no deployment or data migration against the demo or a production host was performed. Follow `portable-deployment.md` after the exact target values and human authorizations are available; do not treat the local archive as authorization to deploy.
