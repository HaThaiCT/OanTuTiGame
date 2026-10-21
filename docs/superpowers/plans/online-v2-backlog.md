# Online v2 backlog (handoff; not an implementation plan)

Status: original handoff scope, superseded by the implementation recorded on this branch. ON-01–ON-07 software is implemented; ON-08 host/provider commissioning is intentionally held for explicit human authorization. Evidence and exclusions: [Online software release receipt](../../implementation/rebuild/online-software-release.md).

- `LAN_BASE_SHA=330630d5dbfd4c1da71721bde27fb2cd89806eeb`
- `LAN_CI_RUN_URL=https://github.com/HaThaiCT/OanTuTiGame/actions/runs/39508776109`
- `LAN_BRANCH=release/lan-v2`
- `ONLINE_BRANCH=develop/online-v2`
- Shared engine, ledger, map, submission, and execution authority remain sourced from LAN; Online adds identity, delivery, admission, and commissioning work without forking those domains.
- Any future schema change adds a new migration; applied SQL files are immutable.

## Ordered backlog

### ON-01 — Validated ONLINE config and delivery material

- Status: `IMPLEMENTED`; verified under strict Online config and protected delivery tests.
- Existing symbols: `IdentityService.authProfile`/profile config in `packages/server/src/identity/service.ts`; server startup/config validation in `packages/server/src/app.ts`; `ONLINE` configuration already distinguishes route availability.
- Acceptance: ONLINE startup validates the required exact HTTPS public base URL and mail settings; LAN starts without SMTP configuration or network access. Verification/reset delivery material is protected at rest and cannot be reconstructed from a development-only plaintext token flag. Design threat model and token custody before writing a consumer.
- Prerequisites allowed: security-approved token encryption/key custody and config contract. Do not select a provider or enable external delivery without separate authorization.

### ON-02 — Durable mail consumer

- Status: `IMPLEMENTED`; isolated consumer tests exercise lease recovery, fencing, retries, expiration and encrypted material.
- Existing symbols: email outbox topics in `IdentityService.register`/`verifyEmail`/recovery flows; `TournamentControlPlane` in `packages/server/src/tournaments/control-plane.ts` currently owns result-only outbox consumption.
- Acceptance: independent consumer claims mail events transactionally, survives restart without losing requests, retries after 15s/60s/300s then holds and alerts, never sends expired tokens, redacts recipient/token in logs, and tests against an internal fake transport before any real mailbox.
- Prerequisites allowed: ON-01 delivery-material contract; define alert sink and deterministic clock/transport test seam. Keep result consumer ownership separate.

### ON-03 — Register, verify, resend

- Status: `IMPLEMENTED`; current-email binding, one-use tokens, resend invalidation, account capacity and non-consuming page load are covered by service and browser checks.
- Acceptance: concurrent registrations cannot exceed one remaining slot; email is bound to account and verified before login; resend rotates/invalidate prior token atomically; pending accounts cannot login, join teams, or upload; link prefetch never consumes; browser register→delivered verify→login succeeds.
- Prerequisites allowed: ON-01 delivery contract, ON-02 internal transport, test mailbox fixture, account-capacity fixture.

### ON-04 — Recovery

- Status: `IMPLEMENTED`; reset TTL is 30 minutes, reset delivery is internal-smoke-tested, rate boundaries and session/token revocation are covered.
- Acceptance: reset tokens expire in 30 minutes, one-use; enforce 3 requests/account/hour and 20/IP/hour; uniform public responses and `Retry-After`; reset revokes all sessions and sibling reset tokens; pending email accounts remain pending. Do not treat dev-token extraction as mail proof.
- Prerequisites allowed: ON-01/02, controlled internal delivery test, clock and rate-limit boundary tests.

### ON-05 — Verified singleton ADMIN and email change

- Status: `IMPLEMENTED`; Online singleton bootstrap and maintenance recovery use the existing ADMIN identity.
- Existing symbols: singleton-admin enforcement/setup, `IdentityService` reauthentication and actor methods in `packages/server/src/identity/service.ts`; security requirements §05.
- Acceptance: email change requires recent reauthentication, verifies new address and notifies old address; maintenance recovery preserves the same singleton identity, audits handoff, revokes relevant sessions/tokens, and never creates a second ADMIN. LAN accounts are not silently migrated to verified ONLINE identity.
- Prerequisites allowed: authorized recovery custodian, signed maintenance procedure, verified mailbox test. No account migration without explicit policy.

### ON-06 — Team self-service and shared-code lifecycle

- Status: `IMPLEMENTED`; global roster/admission locking and the pre-admission one-team-per-tournament rule are regression-tested.
- Acceptance: team membership/capacity remain atomic under concurrent joins; captain transfer and roster-lock enforcement are authorized/audited; rotate/revoke affects future admission only; existing enrollment survives. Keep LAN ADMIN direct enrollment and ONLINE code-only student admission distinct.
- Prerequisites allowed: ON-03 verified identity, ON-05 singleton ADMIN policy, isolated concurrent DB fixtures.

### ON-07 — Full-app/browser integration

- Status: `VERIFIED_ON_PRIVATE_STACK`; actual Next/Fastify/PostgreSQL flows cover registration, verification, login, team, shared code, email change and password recovery using a recording transport.
- Acceptance: full app enforces exact origin/CSRF, Secure cookie behind configured proxy, pending-account privacy; browser proves register→verify→login→team→shared code and recovery. Unknown auth profile fails closed. Verify API + web + proxy integration on a private test stack.
- Prerequisites allowed: ON-01–06 complete, isolated full-app DB and internal mail transport, test origins only.

### ON-08 — Public commissioning

- Status: `SOFTWARE_IMPLEMENTED; HUMAN_COMMISSIONING_BLOCKED`; this task makes no external provider/host deployment claim.
- Existing symbols: deployment readiness/config and operational runbooks; no production mail consumer/provider evidence is claimed.
- Acceptance: only after separate authorization naming host/domain/mailbox/provider: isolated sandbox/no-network verification, TLS, backup/restore, controlled mailbox delivery for verify/reset, quota/DNS checks, and incident drills. Environment toggles alone never establish `ONLINE_READY`.
- Prerequisites allowed: explicit user authorization for exact external resources and actions, operational owner, signed acceptance records. No real email or public deployment in this backlog task.

## Spec and behavior anchors

Software verification evidence and remaining human-owned commissioning gates: [`Online software release receipt`](../../implementation/rebuild/online-software-release.md). LAN's no-SMTP contract and shared engine/ledger/map/submission authority remain unchanged.
