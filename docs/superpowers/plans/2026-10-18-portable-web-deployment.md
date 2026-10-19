# Portable web deployment implementation

**Status: PAUSED_BY_USER (2026-10-18).** Do not continue deployment until requested. Resume checklist and non-deployment gaps: [deferred deployment and remaining work](2026-10-18-deferred-deployment-and-remaining-work.md).

## Contract
One Linux host runs PostgreSQL 16, Next.js, Fastify and an HTTP/WebSocket reverse proxy. Same packaging works on the personal machine or VPS; host/IP/domain are configuration, not separate applications. No native desktop/mobile clients. Keep loopback binding by default. Never auto-enable unsandboxed bot execution. This packaging must not claim production readiness before S02/S06, off-host recovery, TLS and review gates.

## Work
1. Replace obsolete Vite/dist web container with Next.js standalone build; preserve SSR and API rewrites.
2. Replace SQLite-only compose topology with PostgreSQL and versioned schema initialization, separate application DB role and file-based passwords. Keep legacy SQLite storage only for still-mounted compatibility routes, not v2 authority.
3. Proxy normal pages to Next, API and WebSocket to Fastify; use a single configurable HTTP origin. Default localhost only.
4. Build images and start an isolated throwaway database/object volume on a different loopback port. Exercise public pages, auth, migrations, proxy and restart persistence without touching live demo DB. No public listener, system install, production migration or SSH changes.
5. Document exact local/VPS setup, secrets creation, external TLS boundary and remaining runtime gate. Missing VPS access does not block local package verification but does block a claim of VPS certification.
