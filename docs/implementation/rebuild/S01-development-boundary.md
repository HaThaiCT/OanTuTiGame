# S01 development boundary — not release acceptance

`deploy/linux/rebuild-config.mts` validates only the isolated development namespace inventory. Its `ok` means field/path/role/port boundaries passed; it does not mean DEVELOPMENT_CONFIG_READY, sandbox certification, HTTPS trust, backup readiness, or product completion. Production must use the full typed deployment preflight defined in specification05§7.4; do not import this validator as a production bypass.

Before opening or creating runtime storage, callers must recheck filesystem ownership, nonsymlink components and private modes immediately at use; validation alone cannot prevent a later same-user path replacement. Runtime paths and PostgreSQL namespace must never resolve to donor data. The new cluster is development-only, uses current-user peer mapping to distinct restricted PG roles, and cannot stand in for production service UID separation.

Verification exercised:
- `node --test tests/rebuild-config.test.mjs`:15 behavioral cases pass, including nested domains, real symlink-to-donor and exposed0755runtime-root rejection. Those defects were observed failing before their fixes.
- Strict standalone TypeScript compilation of validator: exit0.
- Actual inventory validated against forbidden donor roots: ok, releaseReady=false.
- Private checksummed PG cluster accepts mapped app connection and rejects CREATE TABLE with permission denied. No product migrations or donor DB access.
- Exclusive file creation/fsync/rename/parent-fsync/readback in new objects/staging/spool succeeds; not power-loss or ledger acceptance proof.
- Private CA chain/localhost validation and temporary loopback HTTPS client/server succeed with explicit CA; no system trust changes, cold browser trust pending.
- Isolated Rust/WASM toolchain compiles a throwaway reciprocal-proximity function and Node instantiates it with expected outputs; not engine/native-browser parity.

Historical source snapshot and its manifest remain outside Git in mode0700 preservation root. Credentials and private CA keys remain outside Git; evidence records paths and permissions only, never contents. S01 remains IN_PROGRESS until consumed development prerequisites and review are closed. G1–G4 remain pending.
