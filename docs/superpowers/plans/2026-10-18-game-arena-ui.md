# Game Arena UI Implementation Plan

**Goal:** Recreate the visual language and responsive composition of https://game-arena.ai across every existing OanTuTi portal route, not a partial homepage reskin. User explicitly requires full fidelity. Preserve OanTuTi branding, Vietnamese content and all working product functionality.

**Architecture:** Existing Next.js app, Tailwind and shared CSS tokens. Shared shell and visual primitives govern every route. Route-specific changes replace the prior navy/violet esports composition with the reference's charcoal, monospace, compact borders and restrained controls. No backend contract changes, fabricated leaderboard, third-party branding or unlicensed artwork/font copying.

## Reference contract
- Charcoal canvas #151618, panel #202123, subtle #292a2d, off-white text, muted gray secondary, thin low-contrast borders.
- Monospace typography throughout; locally available monospace fallback, not proprietary Berkeley Mono files.
- Compact single-line desktop header, expandable mobile navigation; understated light primary button, outlined secondary controls.
- Homepage desktop: left introductory headline, right real selected-tournament standings/bracket summary; full-width search, colored format filters, thumbnail tournament cards. Mobile stacks content and collapses navigation.
- Existing workspace/admin/auth forms, boards, replay controls and tables receive the same treatment; preserve all fields, handlers, permissions, audit, first-password-change and reauth flows.
- Empty/error/loading states remain honest. A missing standings snapshot cannot become fabricated global rankings.

## Tasks
- [x] Shared shell, themes, tokens, web navigation and homepage composition, using real public tournament data. Added reference-style sortable/selectable ranking and paginated/filterable tournament cards.
- [x] Tournament, bracket, announcements, admission, live/replay/projector surfaces: reference-style panels, typography and controls without changing game behavior.
- [x] Workspace, source IDE, submissions/private tests/disputes and organizer/map/adjudication surfaces: full visual cutover preserving all interactions. Fixed Monaco beforeMount parameter typing exposed by final build.
- [x] Auth pages and first password change, header session and light/dark/system theme controls: consistent reference styling.
- [x] Production build and browser verification of web routes, ranking selection/sort, pagination/search/reset, theme persistence and real admin/team authentication. No native desktop/mobile application deliverable, per user clarification.
- [x] Evidence recorded in ../../implementation/rebuild/2026-10-18-ui-reference-evidence.md, including measured reference geometry and explicit proprietary-font/artwork differences. Human visual acceptance is separate from implementation verification.

## Review focus
Long Vietnamese tournament names, narrow mobile headers, dense standings tables, form errors and limited sessions must remain usable; no controls removed merely to obtain a cleaner screenshot. No backend/database tests against the live demo database for a visual-only change.
