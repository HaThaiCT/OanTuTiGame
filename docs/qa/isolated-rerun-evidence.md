# Isolated lifecycle rerun — 2026-10-26

## Observed baseline and isolation

- Branch `develop/online-v2-2`, HEAD `5855f2fc740f34f7413054b9d7ee0c6996f81bb9` at initial `git` observation. Historical ports15611/15612 were not listening.
- Fresh database `arena_isolated_20261026_lifecycle_test`, TCP127.0.0.1:15543, container `oantuti-local-online-test-pg`. Applied official `deploy/linux/apply-migrations.mts --apply --grant-to arena_app`; receipt `2026-10-26-isolated-rerun-evidence/migrations.log`.
- API `http://127.0.0.1:15621`, web15622, browser origin `https://127.0.0.1:15623` (disposable self-signed TLS proxy). ONLINE profile; no verification-skip flag, dev executor OFF. Isolated API/Web/TLS service names `isolated-lifecycle-api`, `isolated-lifecycle-web`, `isolated-lifecycle-tls`.
- Storage `/tmp/oantuti-isolated-20261026/storage` mode0700; private credentials `/tmp/oantuti-isolated-20261026/credentials.json` mode0600. Passwords never stored in repository artifacts.
- Four explicit prerequisite users `qa_admin`, `qa_alice`, `qa_bob`, `qa_carol` seeded with real password hashes and verified email timestamps. This exercises verified-user downstream flows, **not mailbox ownership verification delivery**. No domain lifecycle states or sessions were seeded. Browser sessions were obtained through real login.
- Initial admin redirect loop was runtime configuration, not a source fix: build-time API_BASE alone did not set server-side `lib/api.ts` process.env.API_BASE. Relaunched only isolated web with API_BASE15621. Stable organizer page and auth/me200 ADMIN/FULL/ONLINE followed.
- A disposable admin cookie was accidentally printed in a tool transcript during diagnosis. Its session was revoked and private admin password rotated immediately; saved trails contain only method/URL/status and no headers/cookies.

## Fresh actions actually executed

Tournament `17d518be-2a9e-458f-9341-2e407156e7ec`, **Isolated Native Lifecycle 2026**.

1. ADMIN browser-origin course creation200 (`QAISO26`), rendered organizer form tournament creation201 (SINGLE_ELIMINATION, max2).
2. Published four isolated standard8x8 map records via authenticated browser-origin APIs201 each. Used actual map commitment UI200; enabled global rating through checkbox200; published tournament200; assembled four-map knockout pool through rendered select/button handlers200; opened registration200.
3. Alice logged in normally; created own team via browser-origin API201 (`856081fc-5250-4467-8801-c23486deabd8`). Invited Bob201 (`a2849000-6d57-4506-82ae-ae53dc9b1b5f`); Bob logged in normally and accepted200. Persisted invitation is ACCEPTED.
4. Carol logged in normally and created own second team201 (`6d4b6e36-a3ab-4390-8040-6ff0cd9254bf`). Team creation/invitation were browser-origin API actions, **not team-creation form coverage**. The rendered registration page's create-team link sent the logged-in student back to `/tournaments`; that navigation was not fixed here.
5. Alice and Carol used rendered registration button handlers201 each. Automation could not reliably accept the native confirm through its dialog policy; each authorized click used page-world `window.confirm=()=>true` then the rendered DOM button `.click()`. No server response/state was mocked. Both UI screens displayed pending review. This is not native-confirm interaction coverage.
6. ADMIN used rendered approval button handlers200 each, same confirmation override. Both registration rows are APPROVED, two tournament_entries exist. Confirmation screenshot shows actual Carol approval.
7. Built ZIP from repository `sdk/python/starter_bot.py` + `oantuti.py` using zip, attached through real file input and submitted both official upload forms200. Alice receipt `883045bc-9b73-48d2-8c8c-c6862292975d`; Carol `6a3bcb0a-02e6-4f00-89a1-d870c9fd23cd`. Both UI receipts show VALIDATING; persisted two jobs are QUEUED, zero job_attempts.
8. ADMIN close-registration first correctly required reauth403. Entered real password in UI reauth200; automatic retry close-registration200. Tournament now VALIDATING_SUBMISSIONS version5.
9. Actual UI lock rejected409 `INTAKE_DRAINING: Submissions are currently compiling; wait for drain before locking`. Captured explicit browser-origin lock409 and start503 `NATIVE_EXECUTION_NOT_READY: authenticated game and build workers are required`.

## Exact current boundary

Readiness503: database and schema32 pass; executionPlane confirms dev executor OFF; objectRoots pass; executionGateway false (`no native gateway configured`); workers false (`no complete authenticated native worker capacity`). Backup fence is explicitly off for this isolated acceptance environment, so this is not a production readiness claim.

Native commissioning belongs to the separately reviewed operator installer. No cutover occurred. Current general sudo authorization is unavailable: commissioning owner reports `sudo -n true` and `sudo -n -v` exit1, password required. Fixed-whitelist smoke helpers are not authority to install the worker or run isolated API with supplementary group984. Exact missing prerequisite: human-authorized installation/start of reviewed native worker and fixed isolated API launcher with `OANTUTI_NATIVE_CONFIG=/etc/oantuti-qa-native/native-gateway.json`, API-only supplementary arena-supervisor984, distinct API artifact store, and authenticated worker capacity. No host restrictions or sudoers were weakened.

Therefore native BUILD→READY, successful roster lock/start, accepted official game results, result appeal, rating application, and archive **remain unexecuted**, not passed. Persisted zero accepted_results and zero rating_events are recorded, not replaced with fabricated outcomes. Keep this stack and its two real queued builds for the authorized commissioning continuation.

## Raw receipts

Directory `2026-10-26-isolated-rerun-evidence/` contains binary PNGs for registration-open, pending registrations, real approvals, both uploaded receipts, and lock-draining, plus sanitized browser trails, migrations log, readiness.json, lifecycle-guards.json, and database-state.json. Database capture includes a harmless failed read of nonexistent `team_members`; invitation ACCEPTED is persisted, while exact membership table was not separately captured. Credentials and TLS private keys are excluded.

No shared preview/demo service or domain database was modified. No UI/backend source edit or commit was made by this runtime/browser worker. Web build succeeded; no blanket test suite was run against these fixtures.
