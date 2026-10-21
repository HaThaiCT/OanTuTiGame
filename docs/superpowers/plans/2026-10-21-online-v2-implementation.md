# Online v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete ON-01–07 Online software, verify private full-stack journeys, publish the Online branch, and prepare ON-08 until named external infrastructure and human commissioning authorization are required.

**Architecture:** Keep the existing Fastify/PostgreSQL domain services and Next portal. Add protected transactional mail delivery and explicit verified identity state; extend existing team/admission services under a shared transaction lock. Keep LAN operationally independent and preserve all engine/ledger semantics.

**Tech Stack:** TypeScript, Node 24 Argon2id/crypto, Fastify 5, PostgreSQL 16, Next.js, Vitest, existing Rust verifier; provider-neutral TLS SMTP transport.

**Spec:** `docs/superpowers/specs/2026-10-21-online-v2-design.md`, existing ON-01–08 backlog and `docs/specs/v2/01-PRODUCT-REQUIREMENTS.md`, `03-ARCHITECTURE-DATA-CONTRACTS.md`, `05-SECURITY-OPERATIONS-QUALITY.md`.

## Global Constraints

- Work exclusively in `/home/ha-thai/OanTuTi-rebuild` on `develop/online-v2`; preserve LAN/main refs, donor workspace, demo DB and demo services.
- Reset 32 random bytes/30min; verification 32 random bytes/24h; invitations 48h/one-use; recent reauth <=10min; maxTeamSize 1–5/default3; accountCapacity atomic.
- Reset/resend 3/account/hour and 20/IP/hour; mail failure backoff 15s/60s/300s then hold+alert. No plaintext token persistence/logging.
- Add migrations 028 identity/mail and 029 teams/code; never modify applied migration SQL/checksums. Update schema-version and dependent expectations only at integration.
- No external email/public deploy/provider/DNS/tag/Release/image publication; Online branch push only. G0–G4/U5 are not software test claims.
- Isolated checks use explicit arena_*test* database, current_database confirmation and migration CLI. Never run cleanup-capable tests on demo.
- Agents skip builds/lint/tests/formatters mid-flight. Integrator owns red/green checkpoints, shared app/config/protocol integration and final verification.

## Review Focus

- Mail acceptance then process crash may duplicate one link, never mint a second token or lose durable request: lease/restart and stable Message-ID test in Task 2.
- Historical token consumption must not activate changed/LAN email: bound-address and no-backfill tests in Task 3.
- Unknown auth profile, spoofed forwarded IP/proto, or missing Origin cannot open Online mutation: full-app tests in Task 5.
- Cross-team invitation acceptance races admission/captain transfer: global roster/admission lock concurrent tests in Task 4.
- Held/rotated/expired encrypted mail must not leak secrets or send stale links: retry/eligibility/key-rotation tests in Task 2.

---

## File responsibilities and integration ownership

- Identity/mail: new `packages/server/src/identity/online-config.ts`, `mail-crypto.ts`, `mail-outbox.ts`, `mail-consumer.ts`, `smtp-transport.ts`; existing identity service/routes and bootstrap/recovery scripts.
- Team/admission: existing teams service/routes, tournament admission/entry-code services/routes plus small `teams/roster-policy.ts`; migration 029 and focused tests. Do not create a second team domain.
- Web: existing API helpers/AuthProfile/auth pages/EntryCodesPanel/JoinWithCode plus workspace team/account panels. Reuse visual/API conventions.
- Integrator owns `app.ts`, `index.ts`, `auth.ts`, readiness, migration 028/schema-version, dependency installation, full-app fixtures, deployment files and docs. Agents coordinate protocol additions rather than modifying unrelated exports.

### Task 1: Validated configuration and protected delivery (ON-01)

**Files:** Create identity `online-config.ts`, `mail-crypto.ts`, migration `028-online-identity-mail.sql`; modify schema-version; test `online-mail-config.test.ts`.

**Interfaces:** `resolveAuthProfile(env?: NodeJS.ProcessEnv): AuthProfile`; `loadOnlineConfig(env?: NodeJS.ProcessEnv): OnlineConfig | undefined`; `OnlineConfig` owns publicBaseUrl, SMTP options and private keyring. `MailKeyring` has currentKeyId and Map of 32-byte keys; seal/open take a stable AAD string. No SMTP connection at load.

- [x] Write config/crypto behavioral tests: unknown/empty profile rejected; LAN needs no SMTP; ONLINE rejects HTTP/path/mismatched origin, invalid TLS/port/mailbox/proxy and insecure secret file; tampered AAD/ciphertext fails and retained prior key decrypts.
- [x] Run isolated focused test; observe intended missing behavior failure.
- [x] Implement strict file/env config and AES-GCM encrypted envelope; add immutable migration for email_verified_at, target-email token binding, identity rate counters and durable mail records keyed to outbox event ID. No verified-state backfill.
- [x] Run focused tests and migration apply/status on test database; observe actual columns/constraints.
- [x] Commit task files explicitly.

### Task 2: Durable provider-neutral mail (ON-02)

**Files:** Create identity mail-outbox/consumer/smtp-transport, focused `online-mail-delivery.test.ts`; modify package lock only for exact SMTP dependency. App lifecycle integration stays Task 5.

**Interfaces:** `MailTransport.send(message: MailMessage): Promise<void>`; `MailConsumer(db, config, transport, options?)` with `tick(): Promise<void>`, `start(): void`, `stop(): Promise<void>`; `enqueueIdentityMail(client, keyring, input): Promise<void>` inside identity transaction. Message contains recipient/from/replyTo/subject/text/messageId, never loggable raw exception data. `input` binds userId/topic/purpose/tokenHash/rawToken/recipient/expiresAt; notification may omit token and has finite expiry.

- [x] Write real-DB delivery tests for encrypted persistence, claim exclusion, restart after lease, stable message ID, exact retry due times/hold alert, expiry/rotation suppression, key loss/tamper fail-closed and result-outbox noninterference; recording transport only in tests.
- [x] Run intended red before implementation.
- [x] Implement fenced lease consumer, bounded transport timeout and explicit safe alert; delete delivery material on terminal state. Add maintained SMTP adapter with required verified TLS and no LAN side effects.
- [x] Run focused tests and throwaway live local transport scenario, then explicit file commit.

### Task 3: Complete identity lifecycle and singleton operations (ON-03/04/05)

**Files:** Modify identity service/routes/online identity tests, bootstrap-admin.mts/recover-admin.mts; add `online-identity-lifecycle.test.ts` and test delivery utility. Reuse Task 1/2, remove dev plaintext-token path entirely.

**Interfaces:** Extend IdentityService constructor third optional `{mail?: IdentityMailOptions}`; ONLINE requires delivery capability. `resendVerification(email: string, ip: string): Promise<void>`; `requestPasswordReset(email: string, ip?: string): Promise<void>`; `requestEmailChange(sessionToken: string, newEmail: string): Promise<void>`; verifyEmail handles purpose-bound verification/change; public `GET /api/v2/auth/profile` returns validated authProfile. Retry errors carry retryAfterSeconds, mapped centrally to Retry-After. Operator bootstrap/recovery use shared service transaction methods, never HTTP authority.

- [x] Add regressions proving account last-slot race, pending/private denial, current-email binding, resend invalidation, 30min reset expiry, 3/20 rate boundaries for known/unknown accounts, sibling token/session revocation and pending stays pending. Test wrong-purpose/consumed tokens and stale email-change request.
- [x] Run focused red cases on old behavior.
- [x] Implement account/table locking, current verified state on login and authenticateToken, uniform recovery/resend, email change with reauth and old-mail notification, singleton pending Online bootstrap/recovery with no LAN conversion.
- [x] Migrate old standalone tests to real encrypted recording transport and explicit verified ADMIN fixture, capacity settings. No dev token extraction compatibility shim.
- [x] Run isolated identity tests and operator service smoke; preserve LAN limited-session/password rules; commit files explicitly.

### Task 4: Team self-service and code lifecycle (ON-06)

**Files:** Modify teams service/routes, tournament admission/entry-code services/routes; create roster-policy helper and `029-online-team-lifecycle.sql`; focused team/code tests; add required protocol DTOs in existing protocol source.

**Interfaces:** TeamService gains `createOwnTeam(tournamentId,name,actor)`, `listOwnTeams(actor)`, `issueInvitation(teamId,username,actor)`, `listInvitations(actor)`, `respondToInvitation(id,decision,actor)`, `revokeInvitation(id,actor)`, `removeMember(teamId,userId,actor)`, `transferCaptain(teamId,userId,actor)`, `leaveTeam(teamId,actor)`, `closeTeam(teamId,actor)`; explicit deployment profile at construction. Private recipient inbox identifies invitations by UUID and actor binding, not bearer URL. Entry code service gains rotateCode/revokeCode with audited revision. `lockRosterAdmission(client)` is shared transaction advisory lock, acquired before tournament/team/user locks by every mutating path.

- [x] Write focused real-DB regressions for pending/limited/LAN student refusal, invitation 48h/one-use/intended recipient, last-slot concurrency, accept-vs-enroll/transfer, roster immutability after entry, captain transfer/leave/solo close, one-team-per-tournament (not per-course), code rotate/revoke preserving enrollment and registration window/rate/capacity concurrency.
- [x] Integrator runs red cases before source changes and later green after wave.
- [x] Implement reusable policy and migration; complete team APIs with private no-store responses and audit. Gate LAN direct membership/enroll versus ONLINE student invitation/code paths; strengthen full-session checks without bypass aliases.
- [x] Reuse admission validation for code redemption and record code ID/revision; serialize issuance/rotate/revoke/redeem; one active revision.
- [x] Run focused checks at integration, inspect actual concurrent outcomes and commit task files explicitly.

### Task 5: Full app, browser surfaces and deployment readiness (ON-07)

**Files:** Integrator modifies app.ts/index.ts/auth.ts/readiness and tests; web worker modifies API helpers, auth profile/panels and workspace/account/team/code UI; separate Next dist config when needed.

**Interfaces:** ServerOptions optional typed Online config and mail transport injection for controlled tests; production entrypoint loads strict config. No public env option enables fake mail. Hooks start consumer onReady and await stop onClose; entrypoint owns DB close on SIGTERM/SIGINT. Authenticated cookie mutations require exact Origin plus existing CSRF rule; public auth requires exact origin, no pending session requirement. Public read-only profile supports fail-closed probing. ONLINE Secure cookies unconditional. Next pages read fragments client-side and verify only on explicit button.

- [x] Add full createApp regression tests for invalid config before any background work, foreign/missing/local-private Origin refused Online, trusted/untrusted forwarding, Secure cookie, pending full-app private denial, graceful consumer drain and restart.
- [x] Integrator runs red before integration edits, then proves green after complete wave.
- [x] Implement strict config/lifecycle/security and truthful mail/config readiness separate from execution certification.
- [x] Update web API/panels: dedicated profile probe; no auto-consume on mount, resend, 30min reset, delivery-neutral copy, unknown-state refusal, fragment token handling, account email change and complete team/invitation/captain/code controls. Preserve visual conventions and public-private boundaries.
- [x] Run private full-stack actual browser journey using delivered in-memory test messages and isolated database/private roots/ports/build directory; prove no-consume navigation, register/verify/login/team/code, recovery, email change and LAN regression. Capture redacted request/status and DB assertions; remove throwaway tools.

### Task 6: Independent review, deployment preparation and publication (ON-08 reachable work)

**Files:** Update Online backlog status/progress, add Online software receipt and deploy/runbook/config template consistent with existing Compose/secret separation, README links and CI expected schema only where required.

- [x] Run isolated full JS suite, Rust workspace tests, server typecheck, separate web production build, Compose configuration and current CI-equivalent verifier/image smoke where environment permits; record skips truthfully. Local Compose plugin unavailable; hosted exact-SHA Compose validation passed.
- [x] Independent reviewer examines complete Online diff/source for token/storage/privacy/authorization/migration/lock/lifecycle and LAN regressions; fix reproducible blockers and rerun affected checks.
- [x] Supply validated deployment config/secret inventory, offline preflight (no mail), migration/bootstrap/recovery/rotation/hold/rollback instructions. Identify exact host/domain/provider/mailbox/TLS/DNS/backup/sandbox/human signoff prerequisites with commands and expected evidence, not fabricated PASS.
- [x] Commit only intended Online files, push develop/online-v2, observe exact-SHA CI (verify/images green, publication skipped), verify LAN ref unchanged.
- [x] Stop only at genuinely unreachable human deployment resources/authorization; keep objective active, report exact needed values/actions and already exercised evidence. No claim of public Online deployment.

## Execution decision

User explicitly requests autonomous end-to-end work until human deployment intervention. Use bounded parallel domain workers with integrator ownership of shared files/checks and one final independent review; no further planning confirmation pause. Design builder review findings must be resolved before implementation, except external commissioning decisions intentionally left for deployment.
