# Comprehensive LAN Rating Showcase Plan

> **For agentic workers:** execute task-by-task with `superpowers:executing-plans`; the user approved the target size (48 teams, 30 published Rated contests, plus Pending/Rejected examples). Preserve all current records.

**Goal:** Build an additive, repeatable LAN showcase with 48 fictional teams, varied real games and at least 30 real approved global-rating contest publications.

**Architecture:** A pure deterministic contest planner plus a separate `demo:showcase` orchestrator. Provision and play via existing product APIs/dev runner; use database only to observe state and resume. Ratings/results are never directly inserted. The existing `demo:seed` and current demo remain unchanged.

**Tech Stack:** Node/tsx, existing Fastify APIs, PostgreSQL 16, local runner, checked-in Python/TypeScript/C++ SDKs, Vitest.

**Spec:** User-approved scope in this session; `local://global-team-rating-plan.md`; `docs/implementation/rebuild/demo-and-tests.md`.

## Constraints
- Preserve existing demo and all operator/user data; additive showcase tag only, never DROP/TRUNCATE, `git clean`, or volume reset.
- Do not use fixture SQL to invent games, accepted results, ratings, or publication generations. Every published contest must follow real runner → accepted evidence → finalization → explicit authorized rating decision → worker publication.
- Synthetic names and credentials only; private external credentials file mode 0600, no secrets in repo/output artifact.
- Respect receipt/build quotas and real worker states. No status/result/rating fabrication or direct writes to authoritative result/rating tables.
- 48 teams over 3 fictional courses; 30 Rated tournaments: 8 SINGLE_ELIMINATION, 8 SWISS_PLAYOFF, 7 ROUND_ROBIN, 7 ELO_ARENA; each has 4 teams, with deterministic rotating fields that cover every team multiple times.
- Add two separately labeled real review examples (one PENDING, one REJECTED), plus an Unrated comparison. Preserve preexisting `RATEDFINAL` and all other data.
- Use 12 authentic SDK-backed bot variants and 12 validator-approved maps. Native C++ requires the actual configured compiler; unavailable toolchain fails preflight rather than substituting a Python Bot.
- Development executor is unsandboxed; bots are locally authored trusted fixtures only. Never present this demo as safe for arbitrary uploaded code.

- Worker builds only four submissions per contest, stagger them within the official compile limit, wait terminal READY, and never retry an in-flight receipt.
- Rating ADMIN re-auth (10-minute window) must be refreshed through actual login/re-auth endpoint before each decision; no fake timestamp or direct session row writes.
- Store administrator and student passwords only in an external mode-0600 credentials file; never write session cookies or password values to the manifest/log.
- Refresh the ADMIN authenticated session (using the real login/reauth API flow) before each approval; key each decision deterministically by tag, contest index and review input revision so a retry returns the canonical receipt instead of a duplicate approval.
- If bulk provisioning commits but its response is lost, reconcile deterministic usernames. For existing showcase accounts whose original one-time secret is unavailable, reset only that explicitly tag-owned account through the reauthenticated organizer endpoint and record the newly returned credential privately; do not create duplicates.
- State machine is derived from API and read-only DB inspection, never assumed from the last manifest write. In DRAFT: add four distinct pool maps for SINGLE_ELIMINATION/SWISS_PLAYOFF (one for RR/ELO), commit a map, set grace 0 and Rated, then publish and open registration. Before lock, all four receipts must be READY and terminal.
- Start and round-one scheduling are separate transactions. If resume sees `RUNNING` with zero tournament_rounds, recover only through a supported organizer workflow; never falsely mark the contest as progressed. Inspect existing scheduler/recovery APIs and add a safe API seam only if no supported route can resume it.
- After `start`, set/read back appealWindow 0 while state is RUNNING (or PROVISIONAL if a crash happened first). After approve, poll rating review/publication until `updating=false` before continuing; resume by reading actual contest decision and active generation.
## Tasks

### 1. Deterministic plan and resume manifest
Files: new `deploy/linux/demo-showcase-plan.ts`, `tests/demo-showcase-plan.test.ts`, root package script. Exports: `parseShowcaseArgs(argv)`, `buildShowcasePlan(tag, seed, count=30)`. Test tag/seed/count validation, exact format counts, 48 distinct team slots, four unique teams per field, repeated coverage, deterministic output, first-four format smoke, and mismatched-manifest refusal. Use JSON manifest with stable version, plan digest, state/checkpoint IDs, no credentials. Every run compares actual API/DB observations before resuming.

### 2. Real assets, cohorts and language variants
Files: new `deploy/linux/demo-showcase.ts`, fixture bot templates under `deploy/linux/showcase-bots/`, fixture tests. Provision 3 cohorts × 16 teams using courses/accounts APIs, two fictitious students/team, unique names and memberships. Create 12 authored strategy variants (4 per SDK language), validate/compile/smoke each through official submission path; create 12 maps via map API and require validator success. Tests prove variants launch/obey protocol; API tests prove no SQL writes to authoritative result/rating tables.

### 3. Contest rotation, execution and checkpoints
Create a 4-team tournament per plan record. In DRAFT add required pools (4 maps for KO/Swiss; 1 for RR/ELO), commit the version played in round 1, set grace zero and Rated, then publish/open enrollment. Submit four bot variants sequentially with only one in-flight build/team; wait for READY before lock, seed ordinal, and start. Set/read back appealWindow=0 after start. Await every current round/stage seal, accepted terminal results and PROVISIONAL; use actual lifecycle endpoint to finalize. Persist checkpoint after each observed phase. On resume, reconcile API/DB by deterministic names/IDs. Detect RUNNING with no round-one schedule and STOP with explicit diagnostic rather than fabricating progress; do not auto-call private scheduler methods. Test resume from each state and no duplicate resources. If no supported public/API recovery exists for RUNNING-with-zero-rounds, add a narrowly scoped organizer recovery API with an authorization/audit/transaction regression before seeding.

### 4. Rating decisions and long-form history
For each valid completed contest, ADMIN finalizes, reads fresh review, reauthenticates, approves with idempotency key, then waits for active generation before next approval. This produces actual chronological rating history and diverse ranks. Independently create/leave one finalized PENDING and one finalized REJECTED contest and one Unrated comparison; verify none affect published history unless approved. Never seed placements or ratings directly.

### 5. Final acceptance and operations
Document exact command, expected measured duration, resume semantics, URLs, ADMIN/STUDENT/guest paths, and credentials file location. Use isolated test DB for tests only; run all tests/types/build, then seed only active isolated rebuild dev DB. Verify counts: 48 teams, 30 approved Rated contests, 2 review examples, 1 Unrated, exact 8/8/7/7 distribution, four valid distinct participants/contest, nonzero replay/game evidence, varied ranks/rating history, no quota violations, old demo IDs intact. Browser-verify guest leaderboard/profile, STUDENT public-only access, ADMIN review/status, mobile viewport and both themes. Leave requested demo services running.
