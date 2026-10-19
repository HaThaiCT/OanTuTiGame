# Core role UX — implementation evidence

## Implemented
- Guest navigation: public tournaments only; STUDENT navigation: tournaments/workspace; FULL ADMIN navigation: tournaments/organizer/replays. No admin links in unresolved session state.
- `/workspace` lists enrolled tournament/team rows only; no submission/test/appeal forms on the index. Dedicated membership/enrollment-gated `/workspace/tournaments/:id/teams/:teamId` has URL tabs overview/submission/tests/appeals, mounting active content only.
- `/organizer` separates tournament list/create/teams/maps; `/organizer/tournaments/:id` loads one tournament and separates overview/entries/maps/operations/adjudication. Existing lifecycle confirmations and reauth preserved. No fabricated account/audit/source UI was added where there was none previously.
- Official replay pages/downloads require FULL ADMIN. Public result summaries exclude replayDigest for non-admin. Guest401/student403/limited403 API policy and private,no-store caching; legacy download guarded. Private TEST stays owner-only and renders its viewer inside the team's Test tab, not `/replays`.

## Verification actually exercised
- Isolated PostgreSQL database `arena_role_ux_test` (not live demo DB): server regression 55 files, 331 passed / 1 skipped. Targeted replay/server/accounts suites: 17 passed. Initial migrator peer auth refused; checks used authorized local DB owner `ha-thai` against isolated database instead. Web production build succeeded.
- Guest header shows only Giải đấu; replay page redirects to sign-in workspace. Public tournament has zero replay links.
- STUDENT demo_cap1 login200/FULL: workspace has four enrolled tournament rows and zero forms. Each Xem giải points to its private team route. Overview shows actual candidate, own standings/results and announcements; submission tab renders its own form only.
- STUDENT direct official replay API game/digest403 with private,no-store; result summary200 without replayDigest. Foreign-team page404; replay page404.
- Appeal draft typed in its tab survives switching to Test and back; verification text cleared without submitting an appeal.
- Real owner private TEST uploaded SDK starter ZIP, completed with 11 plies/EXTINCTION and replay. Xem bàn cờ rendered a checksum-verified embedded viewer and progress slider while URL stayed in private Test tab. ADMIN request to this private replay403.
- ADMIN login200/FULL: organizer index has zero forms and scoped management links; single tournament console has its own navigation. Official replay renders slider and WASM verification accepts 11-ply trace (WHITE/EXTINCTION).

## Remaining acceptance boundaries
Human U5 visual/usability acceptance remains pending. Independent final review tool failed and produced no findings/report; do not call this independently reviewed. No destructive correction/finalize was performed on the user's demo tournaments during smoke. Existing semantic regression covers those handlers; this UX change does not certify sandbox/LAN deployment or ONLINE. No push/merge/deploy performed.
