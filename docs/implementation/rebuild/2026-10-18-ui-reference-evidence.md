# OanTuTi website visual cutover

Reference: https://game-arena.ai/ and /leaderboard, inspected in a real browser. User clarification: this is a WEBSITE for playing/competing in OanTuTi, not a native desktop/mobile app or a multi-game/LLM benchmark clone.

## Implemented scope
Shared charcoal palette (#151618 canvas), monospace typography, compact navigation, restrained borders/panels/controls, light primary actions. Homepage has reference two-column introduction + real selected-tournament ranking, search/format filters and OanTuTi illustrated tournament cards. All public tournament/live/replay/projector, authentication, workspace/IDE/submission/private-test/dispute and organizer/map/adjudication components receive the shared design treatment. Actual product workflows and API permissions stay in place.

## Exercised checks
- Production web build (Next.js TypeScript/build) succeeded during integration.
- Real browser desktop route inspection: /, /workspace, /organizer, public tournament, /replays with an accepted game, /projector, /register, /forgot-password, /reset-password, /verify-email.
- 390px browser viewport: homepage, workspace, organizer, tournament, replay, projector and live route each reported page scrollWidth=390 (no page-level horizontal overflow). This is browser responsiveness, NOT native mobile application scope.
- Homepage search `ROUND ROBIN` reduced eight public tournament cards to two; clearing restores the list. Compact navigation expansion exposes the real route links.
- Auth: real demo_cap1 login through /workspace succeeded and produced the authenticated workspace; hydrated team panels expose submission/private-test/dispute forms and actual receipts.
- Accepted replay independently verified using browser WASM: `Engine WASM chấp nhận trace. 11 nước được áp dụng · kết cục Trắng · EXTINCTION`.
- Real ranking uses DEMO ROUND ROBIN round 3, four teams and their server-published points/matches. No fake global leaderboard.
- Remaining website refinements: removed the extra hero description/CTA and forced four-line wrapping absent from the reference. At a 1440px browser viewport the OanTuTi heading measures 500×108px (reference 500×108px); ranking panel x=697.75px, y=97px, width=678.25px (reference table x=697px, y=96.75px, width=678px). Card art height is 200px, matching the reference image height. This is geometry evidence, not whole-page pixel identity.
- Added working ranking sort (rank descending yields first rank 4), selectable published tournament snapshots, four-card pagination (two distinct pages over eight tournaments), reset/search (ROUND ROBIN yields two cards and resets the page), and the reference-style light/dark/system segmented theme selector. System theme preference is applied before hydration.
- Web-only continuation checked ten existing routes at the normal browser viewport, admin login 200/FULL and real organizer tournament/map forms. No native app build or deployment was introduced. Auth ONLINE forms remain profile-gated in this LAN deployment.

## Explicit fidelity boundaries
OanTuTi naming, Vietnamese copy, tournament data and game mechanics are retained. Reference's proprietary Berkeley Mono font files, branding and unrelated game artwork are not copied. Native monospace fallback and original OanTuTi board illustrations differ from the source. Admin/team workflows have no directly equivalent reference pages; they follow its design language but are not honestly describable as pixel-identical source pages. No numerical screenshot-diff parity claim or user visual acceptance yet.

No database test suite was run for this visual-only cutover: it would reset the user's demo database. API/PostgreSQL existing dev services were restored after their prior processes had exited; no schema migration or credential rotation was performed.
