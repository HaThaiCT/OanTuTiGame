# Static review findings — 2026-10-27

Scope: static read-only review of `packages/server/src` (tournaments, submissions+content, ratings+adjudication) and `packages/web/app` user flows, plus user-perspective design checks. Evidence-anchored; no runtime mutation. This file is the fix ledger; entries are updated in place as fixes land.

## P0 — build-breaking

### W1 · `packages/web/app/organizer/page.tsx:64-65` — undeclared `accountsScope`
JSX shorthand `accountsScope` compiles to an undeclared identifier. `next build` (type check enforced) fails `TS2304`; dev render of create/teams/maps sections throws `ReferenceError`. Shipped `.next/standalone` bundle contains `accountsScope:!0`, so committed source no longer matches the deployed bundle.
Fix: `accountsScope={true}`.
Status: **FIXED — `accountsScope={true}` landed (FixWeb). `tsc --noEmit -p packages/web` and 52/52 `test:web` green. Toolchain note: on TS 5.7/SWC the JSX shorthand already compiled to `{accountsScope: !0}` (verified by firing `tsc` emit on a repro), so the cited TS2304/ReferenceError premise did not reproduce; the change is kept for source↔bundle clarity and to rule out tooling drift.**

## P1 — authorization / state integrity

### S1 · `packages/server/src/adjudication/{routes.ts,dispute-service.ts,correction-service.ts}` — missing `scope === 'FULL'` gate
Every other privileged module gates `actor.role !== 'ADMIN' || actor.scope !== 'FULL'` (ratings/routes.ts:47-49, admission-service.ts:1182, content/service.ts:119, submissions/service.ts:124). Adjudication checks role only at routes.ts:85-87,116-118,150-152,177-179 and service gates dispute-service.ts:110-112,66-75, correction-service.ts:79-83,226-228. A `PASSWORD_CHANGE_ONLY` admin session can resolve/preview disputes and file disputes for arbitrary teams — silently releasing the finalize/round-seal blocker.
Fix: add the site-wide gate at all five routes and three service entry points.
Status: **FIXED — gates on all four organizer routes (resolve/disqualify/preview/apply), on dispute-service resolve, on correction validateCommand+disqualify; the createDispute admin exemption now requires `scope === 'FULL'` so a PASSWORD_CHANGE_ONLY admin is an ordinary claimant. Regression: tests/adjudication-guard-fixes.test.ts (S1 blocks/asserts).**

### L1 · `packages/server/src/formats/{swiss.ts:137-138,round-robin.ts:144-145}` — completed encounters vs withdrawn teams drop points
`computeStandings` seeds only ELIGIBLE entries; a COMPLETED encounter whose other side is later EXCLUDED (withdrawal preserves completed games, admission-service.ts:783-787 only cancels non-COMPLETED) hits `if (!sB) continue` — winner loses 3 points/matchesPlayed/Buchholz. Violates TR-07 “sealed results giữ nguyên”. Corrupts Swiss qualification (`is_qualified`) and rating placements.
Fix: seed score-source stats for every team appearing in completed encounters; rank only ELIGIBLE.
Status: **FIXED — `tournaments/formats/{swiss,round-robin}.ts` seed a stats row for every team in the completed history (score sources outside the ELIGIBLE list are filtered before ranking, walkover credit fenced to eligible winners). Tests: `packages/server/tests/static-review-lifecycle-fixes.test.ts` (L1 describe; red against pre-fix code). Targeted format suites (four-formats, swiss-pairing, swiss-bye, pairing-weights, matching) and withdraw/DQ/grace suites green.**

### L2 · `packages/server/src/tournaments/{admission-service.ts,scheduler-service.ts}` + `results/service.ts` — withdrawal/claim race can nullify a decided WALKOVER
`isEncounterStarted` is a lock-free SELECT; broker `claim` can commit `LEASED` after it; withdraw then force-BLOCKs the job, but `recordResult` never checks the game status it selects (`results/service.ts:155-158`) and sets `status='COMPLETED'` (231-234); `handleGameCompletion` overwrites the encounter unconditionally (`scheduler-service.ts:403-410`). A decided walkover can be replaced by points from a match with a withdrawn team.
Fix: in `recordResult`, after the games `FOR UPDATE`, reject CANCELLED games / encounters already WALKOVER|DOUBLE_WITHDRAWAL|CANCELLED; in `handleGameCompletion`, make the encounter UPDATE conditional (`WHERE id=$4 AND status IN ('PENDING','RUNNING')`).
Status: **FIXED — `results/service.ts` adds `ResultRejectedError` + `resultRejectionReason` (plain precheck before staging, authoritative re-read under the games row lock); `scheduler-service.ts` handleGameCompletion encounter UPDATE now guards `status IN ('PENDING','RUNNING')` and early-returns with `tournamentId: null` (no re-mark, no progression events on a refused overwrite). Tests: L2 describe of `static-review-lifecycle-fixes.test.ts` (refusals, ruling intact, voided-encounter overwrite refused, normal completion unaffected); red against pre-fix code. withdraw/DQ/grace/results-durability suites green.**

### L3 · `packages/server/src/commands/idempotency.ts:40-79` — failed run leaves eternally PENDING receipt
No try/catch around `run()`; any expected 409/410/412 rejection leaves the receipt PENDING, and every later retry with that key gets `IDEMPOTENT_IN_FLIGHT` forever. Retry path is bricked by the first failure.
Fix: on run() failure delete the claim row (retry-safe) while preserving concurrent IN_FLIGHT semantics.
Status: **FIXED — release deletes the PENDING claim on run() rejection (concurrency + DONE-receipt preserved); verified red before fix / green after. Regression: tests/adjudication-guard-fixes.test.ts (L3).**

### L4 · `packages/server/src/tournaments/control-plane.ts:73-91` — one bad outbox event stalls all sealing/enqueueing
`result-outbox` loop throws mid-batch without marking the event; every 5s tick re-fails on the same row and blocks `seal` + `enqueue` platform-wide, only `console.warn`ed.
Fix: per-event try/catch with bounded retry, advancing the loop.
Status: **FIXED — `control-plane.ts` `deliverResultOutbox()` (tick's 'result-outbox'): per-event try/catch; failures stamp `deliveryFailures`/`lastDeliveryError` into the payload (restart-proof); after 5 attempts a permanently failing event is marked delivered with a loud warn; malformed payloads (no `gameId`) are marked delivered immediately. The loop always advances; a successful event is delivered only after its processing. Tests: L4 describe of `static-review-lifecycle-fixes.test.ts` (malformed does not block the next event, transient failure retried with bookkeeping, 5-cap poison); red against pre-fix code.**

### L5 · `packages/server/src/adjudication/dispute-service.ts:37-97` — dispute creation not transactional/serialized vs finalize
State pre-check, INSERT, outbox are three autocommit statements; finalize counts OPEN disputes in its own transaction (admission-service.ts:981-988). Interleave produces FINALIZED with an OPEN dispute; double-click inserts duplicates (no unique constraint, migrations/007:6-21).
Fix: `withTransaction` + tournament `FOR UPDATE` + in-tx state re-check + partial-unique idempotent re-create on OPEN/UNDER_REVIEW.
Status: **FIXED — createDispute runs in one transaction holding the tournaments FOR UPDATE (same row finalize locks) with an in-transaction state re-check; refiling on a live OPEN/UNDER_REVIEW dispute returns the existing row, backed by migration 033 (`uq_disputes_live_per_target`, partial unique with duplicate collapse; EXPECTED_SCHEMA_VERSION → 33). Regression: tests/adjudication-guard-fixes.test.ts (L5).**

## P2 — robustness / reasonability

### S2 · `packages/server/src/submissions/artifact-store.ts:132-170` (+ source-materializer.ts:163) — zip-bomb inflate
All limits use declared central-directory sizes; `inflateRawSync(compressedData)` lacks `maxOutputLength`, so a ≤2 MiB upload can inflate to ~GiB in memory before the mismatch check().
Fix: `maxOutputLength: MAX_FILE_BYTES + 1`, map `ERR_BUFFER_TOO_SHORT` to the existing 413 wording.
Status: **FIXED — `parseAndValidateZip` inflates with `maxOutputLength: MAX_FILE_BYTES + 1`; the exhausted-limit zlib error maps to the existing 413 "exceeds single-file limit" wording (a traceback code correction: current Node raises `ERR_BUFFER_TOO_LARGE`, `ERR_BUFFER_TOO_SHORT` kept as the historical alias). `source-materializer.ts` reaches this shared validator (`materializeSource` reuses `parseAndValidateZip`), so both surfaces are covered by one change. Regression: `tests/source-limits.test.ts` "caps the real inflate of a lying central directory at the declared per-file limit" (forged local+central headers declaring 120 B against a 768 KiB stream: without the fix it returns the 400 size-mismatch verdict after fully inflating; with it, 413 before any large buffer exists).

### S3 · `packages/server/src/submissions/service.ts:349-386` — crash between receipt commit and BUILD enqueue strands a VALIDATING row
Only BUILD enqueue site in the repo; the reconciler only requeues expired leases of existing jobs. A stranded row permanently consumes the 2-slot quotum and blocks tournament lock().
Fix: reconciler sweep inserting missing BUILD/TEST_BUILD jobs for non-terminal rows without jobs.
Status: **FIXED — `JobReconciler.reconcile` gained step 2 `requeueStrandedBuilds`: one INSERT…SELECT filing the missing BUILD job for `submissions` rows in `PENDING_SUBMISSION_STATUSES` and the missing TEST_BUILD for `test_snapshots` rows in `QUEUED/COMPILING/SMOKE_TESTING` (RUNNING deliberately excluded), each guarded by `NOT EXISTS (jobs WHERE job_type/target_id)`; the strings reuse the quota constants exported from submissions/service.ts so the sweep stays on the same pending semantics the quota machinery owns. Concurrency serialised by a database-scoped `pg_advisory_xact_lock` (jobs has no `(job_type,target_id)` unique key), rows carrying any job at all stay untouched, and the report grew `orphanBuildJobsInserted`. Regression: new `tests/build-orphan-sweep.test.ts` (stranded VALIDATING row + QUEUED snapshot → exactly one queued job per row with `{tournamentId, teamId}` payload; READY and COMPLETED rows get none; an existing job is never duplicated; second pass inserts 0). Cross-suite note: on a fixture database where an earlier suite wiped `jobs` but left non-terminal receipt rows behind, the repair surfaces by design — the rebuilt BUILD takes `submit()`'s own 150 priority and can beat other suites' un-narrowed claims (reproduced one stray orphan → `durable-jobs` fencing `2`≠`3`); per-suite databases stay clean (7 files / 44 tests green in one combined run).**

### S4 · `packages/server/src/content/{routes.ts:55,service.ts:129}` — `?limit=abc` → NaN SQL LIMIT → unauthenticated 500 (raw pg leak)
NaN survives `parseInt` and the clamp; Postgres 22P02.
Fix: reject NaN to the default at parse time and clamp as integer.
Status: **FIXED — the `/api/v2/news` route resolves the limit through `Number.isSafeInteger` (NaN/non-integer → default 10, so no NaN parameter can reach Postgres) and the `listPublishedNews` clamp became integer-safe (non-integer input resolves to the same default; bounds 1…50 unchanged). Regression: `tests/content-service.test.ts` "treats a garbage public news ?limit as the default page instead of a server error" (`?limit=abc` → 200 with the default page, identical to no-param count; `?limit=1`/`?limit=0`/`?limit=99999` keep the clamped behaviour).**

### S5 · `packages/server/src/content/routes.ts:114` — PUT news without body / null fields → TypeError 500
POST guards with `input.title?.trim()` (service.ts:237), PUT dereferences `input.title !== undefined` (service.ts:295).
Fix: coerce body fields to `string|undefined` before service call.
Status: **FIXED — the PUT route normalises the body through a new `coerceNewsPatch()` before calling `adminUpdateNews`: real strings pass through untouched; a missing JSON body, `null` or non-string field is dropped (empty patch → no-op touch that refreshes `updated_at`), so the service only ever sees `{string | undefined}` fields. Regression: `tests/content-service.test.ts` "coerces a PUT news update without a usable JSON body instead of crashing" (bodyless PUT → 200 with the post unchanged; `{title: null, summary: 42, content: {...}}` → 200 keeping the stored values; a real string edit still updates).**

### L6 · `packages/server/src/tournaments/map-service.ts:238-258` — PUBLIC map with zero revealed versions disappears from the list
INNER LATERAL requires a revealed version even though `WHERE m.visibility='PUBLIC' OR …` includes PUBLIC; `getMap` by slug serves the same map (map-service.ts:214-221).
Fix: LEFT JOIN LATERAL with COALESCE fallback for PUBLIC (same pattern as `getTournamentMapPool`, 334-345).
Status: **FIXED — `map-service.ts` listMaps non-admin branch: LEFT JOIN LATERAL where PUBLIC maps fall back to the current-version row (`mv.version = m.current_version`, coalesce onto `maps.descriptor`) matching `getMap`, HIDDEN maps keep the newest-revealed rule and an inconsistent HIDDEN map with no revealed version stays unlisted. Test: L6 describe of `static-review-lifecycle-fixes.test.ts` (four list cases); map-pool/map-versions/private-map-reveal suites green.**

## P3 — UX / correctness polish

### W2 · `packages/web/app/workspace/join/page.tsx` — dead route, unreachable from any navigation
Full join UI with zero link producers; `#registration` fragment link never renders on the default tab (page targets `/tournaments/:id#registration`, panel only renders under `?tab=registration`).
Fix: point fragment link to `?tab=registration#registration`; (route itself stays as deliberate deep link for entry-code emails/ADMIN handout).
Status: **FIXED — `lib/navigation.ts` adds `tournamentRegistrationHref(id)` (`/tournaments/:id?tab=registration#registration`); join page link uses it. Regression: `lib/navigation.test.ts` asserts the query rides with the fragment.**

### W3 · `packages/web/app/_components/NewsSection.tsx:87` — fabricated “Còn tiỏp…” for fully-rendered 600+ char posts
`isLongPost` mixes a char criterion with a block-count cap that the renderer never applies (`maxBlocks=4` only).
Fix: `isLongPost = blocks.length > 4`.
Status: **FIXED — extracted `newsPostIsTruncated(blocks)` in `NewsSection.tsx`; regression `app/_components/NewsSection.test.ts` covers >4 blocks, ≤4 blocks at 650 chars (no fabricated "Còn tiếp…"), and really-truncated short posts.**

### W4 · `packages/web/app/_components/{NewsSection.tsx:19-24,MarkdownRenderer.tsx:227-231}` — share/copy buttons fake success and no-op on HTTP LAN origins
Clipboard promise unawaited; insecure-context `navigator.clipboard` is undefined → silent no-op. Codebase has proper fallback pattern (EntryCodesPanel.tsx:96-100).
Fix: await/write .then(success)/.catch(fail-marking) with manual-copy fallback.
Status: **FIXED — new `lib/clipboard.ts` `copyText()` (confirm-or-fail, LAN no-op → `false`); `CopyLinkButton` + `CodeBlockView` marks `copied` only on confirmed write, otherwise falls back to an honest "Chép tay" manual-copy prompt with timeout cleanup. Regression: `lib/clipboard.test.ts` (unsupported origin fails, confirmed write true, rejected permission false).**

### W5 · `packages/web/app/page.tsx:63` + `news/[slug]/page.tsx:19-20` — API outage renders as “no news” / plain 404
Homepage feeds `ok:false` as `[]` into the “Chưa có bản tin mới” empty state; article page `notFound()` conflates outage with missing post.
Fix: homepage adds `role="alert"` notice when `!newsResult.ok`; article page returns an explicit error section instead of `notFound()` for transport failure.
Status: **FIXED — homepage renders a `role="alert"` outage notice above the feed; `news/[slug]/page.tsx` classifies `classifyNewsFetch()` → retryable outage section vs plain 404 only for genuinely missing posts. Regression: `app/news/[slug]/page.test.ts` (transport → refusal, completed-no-post → missing, post → present).**

### W6 · register/account/reset password hints and server error — min-only client validation vs server 12–128 rule; verbose raw English server text surfaced
Files: register/page.tsx:38-41,189,207-210; OnlineAccountPanel.tsx:94-97; ResetPasswordPanel.tsx:10,14 (WEAK_PASSWORD hard-maps “ít nhất”, server is range 12-128).
Fix: client hint/validators to full range; keep Vietnamese messages local.
Status: **FIXED — new `lib/password-policy.ts` (12–128 code points via `Array.from`, `PASSWORD_RULE_HINT`, `passwordLengthProblem`); register + reset validators and hints now full-range, `WEAK_PASSWORD` map uses the range text, account panel validates before send and relabels "12–128 ký tự". Regression: `lib/password-policy.test.ts` (boundaries 11/12/128/129, code-point counting for 13 emoji, hint contract).**

### W7 · register/verify/account/reset — async status/error regions non-SR-announced (`role` absent)
Convention from forgot-password/workspace uses `role='alert'/'status'`; these four panels don't.
Fix: add roles on message boxes and busy spinners.
Status: **FIXED — `role="alert"` on error boxes and `role="status"` on success receipts/busy spinners across register (receipt+error), verify-email (verified+busy+error), reset-password (done+error), account panel (loading spinner; password/email notices get success→status/failure→alert). Declarative markup, verified by grep + tsc.**

### W8 · `packages/web/app/page.tsx:209` + `live/[gameId]/page.tsx:22` — raw English statuses; breadcrumb to home
Match ticker prints raw `m.status`; same route uses `encounterStatusLabel` elsewhere. Live breadcrumb “Giỏi đấu” points at `/` instead of `/tournaments`.
Fix: reuse the shared labels map for statuses; correct breadcrumb.
Status: **FIXED — home ticker renders `encounterStatusLabel[m.status] ?? m.status` (same map as the bracket); live breadcrumb "Giải đấu" now targets `/tournaments`. One-line wiring of the existing label map; verified by grep + tsc.**

### W9 · `packages/web/app/_components/SiteHeader.tsx:79-89` — mobile menu `aria-label` static
`aria-label="Mổ điều hướng"` stays open-state-inappropriate when expanded.
Fix: label follows `expanded`.
Status: **FIXED — `aria-label={expanded ? 'Đóng điều hướng' : 'Mở điều hướng'}`; `aria-expanded`/`aria-controls` untouched.**

### W10 · dead weight in web app (cleanup, maintainer_requested)
`TrinityBattleWheel.tsx` (205 ln, zero importers) — dead code. `WasmVerifierPanel.tsx` never mounted from ReplayViewer — unshipped feature path.
Fix: delete the dead component; leave the intended but unwired verification feature awaiting product decision (do not silently splice a half-feature onto ReplayViewer without test expectations).
Status: **FIXED — `TrinityBattleWheel.tsx` deleted (zero importers rechecked at delete time); `WasmVerifierPanel.tsx` left untouched per decision. Non-test cleanup.**

## Server P3 polish

### R1 · `packages/web/app/_components/RatingLivePanels.tsx:299` — first-rated history row shows “CŨ=0, MỚI=1500+Δ”, arithmetically inconsistent (0x≠1612)
Server exposes both `oldRating` (1500-based) and `oldPublicRating` null-for-unranked; UI substitutes 0 for null.
Fix: display `—` when `oldPublicRating === null`.
Status: **FIXED — extracted `historyOldRatingDisplay(row)` in `RatingLivePanels.tsx` and the history cell uses it; `—` for `oldPublicRating === null`. Regression: `app/_components/RatingLivePanels.test.ts` (ranked rows keep their value, unranked rows print `—` not `0`).**

### R2 · `packages/server/src/adjudication/routes.ts` + dispute/correction services — non-UUID param IDs crash with raw PG 22P02 surface text
Sibling ratings module validates ids (ratings/routes.ts:14, 96-105); favorites map to clean `INVALID_*`.
Fix: UUID-validate before service calls; return structured `INVALID_DISPUTE_TARGET`/similar.
Status: **FIXED — UUID_RE (mirror of ratings/routes.ts) validates every path param and the dispute body ids before the services: INVALID_TOURNAMENT_ID, INVALID_DISPUTE_TARGET, INVALID_DISPUTE_ID, INVALID_TEAM_ID, INVALID_GAME_ID; authorization ordering preserved (401/403 beat 400). Regression: tests/adjudication-guard-fixes.test.ts (R2).**

### L7 · `packages/server/src/tournaments/lifecycle-service.ts:109-119` — dead VALIDATING_SUBMISSIONS UPDATE inside a transaction that throws immediately
Rolled back by `withTransaction`. Delete the dead WRITE rather than pretending to drain (keep actual drain behavior already in closeRegistration/auto-runner).
Status: **FIXED (delete) — the rolled-back `VALIDATING_SUBMISSIONS` UPDATE is gone from `lockInternal`; the drain hand-off stays with the deadline sweeps that version-bump and emit TOURNAMENT_DRAINING. Test: L7 describe of `static-review-lifecycle-fixes.test.ts` (draining lock leaves state+version untouched, INTAKE_DRAINING preserved); submission-lifecycle and tournament-lifecycle suites green.**

### L8 · `packages/server/src/tournaments/lifecycle-service.ts:470-495` — `extendRegistration`: no version bump; JS clock instead of DB clock
Fix: `version = version + 1, updated_at = clock_timestamp()` and SQL-time comparisons.
Status: **FIXED — `extendRegistration` bumps `version = version + 1` and decides all cutoff comparisons in SQL (`clock_timestamp()` vs `registration_closes_at`/`$1::timestamptz`); JS `new Date()` comparisons removed. Tests: L8 describe of `static-review-lifecycle-fixes.test.ts` (version bump on success, STALE_VERSION leaves row untouched, passed-cutoff EXTENSION_DENIED via DB clock, backwards cutoff 400, non-open state 409). organizer-operations/tournament-lifecycle suites green.**

## Non-defect design observations (no fix asserted, not part of “all”)
- LAN admission mutators lack idempotency-key receipts (all other domains honor them); request bodies for bulk enrollment; possible future use.
- 032 test-data paths and schema-checksum 30/32 baseline on shared demo are known infra gaps, previously logged; not code defects.
- Legacy v1 surfaces still registered but functional; migration was only to v2 schemas. No defect asserted.
- Dispute re-resolution (already-resolved updates silently re-stamped) is a policy choice, unguarded only via raw API; UI already hides controls.
- Admission DRAFT 404 inconsistency on standings/bracket — API consistency nit only.
- ratings golden fixtures pin top-K second correction; withdrawal-last-place rating inclusion is deliberate policy.

## Verified non-findings (explicitly checked)
- Starter-bot seed author NULL-ability, test status CHECK set, submission intake quota serialization, live membership lookup, private-test read authz, upload body arithmetic, CRC32 method-0 consistency, roster advisory-lock ordering, canonical seeding, Elo/no-op administrative results, dispute re-resolution policy visibility, `resolveWorkspaceDestination` guest default.

## Runtime smoke addendum (2026-10-27, live stack `http://localhost:14440`)

### R3 · create-team CTA still rerouted through `/workspace?returnTo=...` — a logged-in student loops but never opens the team form
Observed on the live local stack as a real-account walkthrough: clicking `Tạo đội trong không gian đội →` on `?tab=registration` sent the authenticated no-team student to `/workspace` and immediately back to the same registration tab (workspace page.tsx:63 redirects any FULL session to `resolveWorkspaceDestination(returnTo)`) — the exact pre-fix behavior the earlier report called fixed. Fix: `tournamentCreateTeamHref` now returns the same-route tab `/tournaments/:id?tab=team`, and the CTA shows only while registration is open; a closed registration renders neutral copy ("Giải đã đóng đăng ký nên không thể tạo đội mới…") instead of a dead-end link. Regression: `packages/web/lib/navigation.test.ts` ("sends the no-team create-team CTA to the tournament team tab, not a workspace loop"), 54/54 web tests green. Verified live: link targets `?tab=team`, form `Tạo đội thi đấu cho giải này` reached directly, full account→team→registration journey completed (team created, registration sent, pending state rendered).
Status: **FIXED (runtime-verified).**

### R4 · registration CTA was offered on a closed-registration tournament (live smoke finding)
The no-team branch rendered the create-team CTA whenever `teams.length===0 && registrations.length===0`, regardless of `open` state, so a `Đang diễn ra` tournament still advertised team creation through the registration tab. Fixed together with R3 by `open`-gating the CTA and adding the neutral closed-registration copy; live walkthrough confirmed the wording on a closed tournament.
Status: **FIXED (runtime-verified, part of R3 change).**
