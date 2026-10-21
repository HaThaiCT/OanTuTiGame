# Dependency advisory disposition — 2026-10-21

Scope: the final clean-install workspace graph. `npm audit` reports two low advisories through Monaco’s declared `dompurify@3.4.15`; `@oantuti/server` uses patched `nodemailer@10.1.7` and `pg@8.23.1`. CI does not run `npm audit`; this record documents the explicit Monaco waiver, not a zero-findings audit.

## Resolved: uuid 9.0.1 → 11.1.1 (GHSA-w5hq-g745-h8pq, moderate)

- Chain: `brackets-viewer@1.9.1` → `brackets-manager@1.11.1` → `uuid@9.0.1`; uuid is the only consumer (`npm ls uuid`).
- Advisory affects `v3/v5/v6` only when the caller passes a `buf`; `brackets-manager/dist/manager.js:137` calls `uuid.v4()` without a buffer, so the vulnerable path was never exercised. Fixed anyway to clear the report.
- Fix: root `package.json` overrides `uuid` to `^11.1.1`; clean lock graph resolves `uuid@11.1.1`. The bracket UI’s prebuilt viewer bundle is unchanged.
- Verification: `node -e "require('brackets-manager')"` loads, `npm ls uuid` clean, and production Next build succeeds.

## Waived: two low DOMPurify advisories in Monaco 0.57.0 (GHSA-p98j-92pf-mc4p, GHSA-6688-9rhm-gjv2)

- The clean npm graph is `monaco-editor@0.57.0` → `dompurify@3.4.15`; `npm audit` reports these two low findings. Registry metadata reports 0.57.0 as the newest Monaco release. The editor package vendors its own DOMPurify 3.4.15 copy into the static assets copied to `packages/web/public/monaco`; forcing npm’s DOMPurify version would not update this browser bundle. `npm audit fix --force` selects Monaco 0.56.0 and is not a security fix for the bundled asset.
- **Independent reachability review:** the vendored `dompurify.js:473` reports version 3.4.15. Monaco’s `domSanitize.js:167-175` documents `sanitizeHtml` as accepting an HTML string; its calls at `245-250` and `267-269` use `RETURN_DOM_FRAGMENT` or `RETURN_TRUSTED_TYPE`, not `IN_PLACE`. `safeSetInnerHtml` at `350-352` sanitizes before replacing target markup. Markdown callers at `markdownRenderer.js:178-181` and `566-567` use that string path; `ui/button/button.js:179` passes a root through the same sanitizing helper. In the vendored sanitizer `IN_PLACE` defaults false and is enabled only by `cfg.IN_PLACE` (`dompurify.js:723,840`). The reviewer found no attacker-controlled DOM `Node` or `IN_PLACE` call path.
- Exposure: Monaco is used in the authenticated team workspace and organizer map editor; the review addresses Monaco’s current call paths only, not arbitrary DOMPurify consumers or future editor versions.
- Disposition: **waived, not fixed**. The vendored vulnerable version remains. Reassess after each Monaco upgrade and immediately if any integration adds DOM-node sanitization or `IN_PLACE`.

## Standing rule

Re-run `npm audit` on the final lock graph before any public release sign-off and after dependency changes; retain the exact finding count and waiver. Do not apply `npm audit fix --force` to this Monaco tree.
