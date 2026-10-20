# Dependency advisory disposition — 2026-10-21

Scope: `npm audit --omit=dev` on workspace `@oantuti/web` (the only workspace with remaining findings; `@oantuti/server` reports zero). CI does not run `npm audit`; this document is the release disposition record.

## Resolved: uuid 9.0.1 → 11.1.1 (GHSA-w5hq-g745-h8pq, moderate)

- Chain: `brackets-viewer@1.9.1` → `brackets-manager@1.11.1` → `uuid@9.0.1`; uuid is the only consumer (`npm ls uuid`).
- Advisory affects `v3/v5/v6` only when the caller passes a `buf`; `brackets-manager/dist/manager.js:137` calls `uuid.v4()` without a buffer, so the vulnerable path was never exercised. Fixed anyway to clear the report.
- Fix: root `package.json` `overrides: { "uuid": "^11.1.1" }`, lockfile entry pinned to `uuid@11.1.1` (`sha512-vIYxrBCC/…`). Note: npm 11.19.0 did not re-resolve the existing lock entry after adding the override (fresh-install reproductions worked); the lock entry was written explicitly and `npm install` then placed 11.1.1.
- Verification: `node -e "require('brackets-manager')"` loads, `npm ls uuid` clean, `next build` succeeds. The bracket UI ships the prebuilt `brackets-viewer.min.js` bundle (unchanged by this override); server does not depend on the brackets tree.

## Waived: dompurify ≤3.4.15 bundled by monaco-editor (2 low)

- Chain: `monaco-editor@0.57.0` (latest upstream release) declares `dompurify@3.4.15`. There is **no fixed monaco release**; `npm audit fix --force` would *downgrade* monaco and still not patch the shipped asset.
- The browser runtime is monaco's **vendored** copy (`esm/vs/base/browser/dompurify/dompurify.js`, `DOMPurify.version = '3.4.15'`), bundled into `min/vs/editor-*.js` which we copy to `public/monaco`. An npm `overrides` bump of the `dompurify` package would **not** change the shipped asset — rejected as a false fix.
- Exploitability: both advisories (GHSA-p98j-92pf-mc4p, GHSA-6688-9rhm-gjv2) require DOMPurify's `IN_PLACE` mode (sanitizing a DOM `Node`). Monaco's `esm/vs/base/browser/domSanitize.js` only ever passes HTML **strings** (`grep IN_PLACE` → 0 matches); `safeSetInnerHtml` sanitizes the string before assigning. The vulnerable path is not reachable through monaco 0.57.0's usage.
- Exposure surface: Monaco runs only in the authenticated team workspace (bot source IDE) and the organizer/ADMIN map editor — no public anonymous surface renders attacker-controlled markdown through it.
- Disposition: **waived, not fixed**. Re-check on every `monaco-editor` upgrade; drop this waiver when upstream ships dompurify ≥3.4.16.

## Standing rule

Re-run `npm audit --omit=dev` per workspace before any public release sign-off and after any dependency change; update this record. Do not apply `npm audit fix --force` (breaks monaco, does not patch the shipped asset).
