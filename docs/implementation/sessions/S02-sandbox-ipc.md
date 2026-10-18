# S02 — Sandbox, IPC và Three-Language Engine Integration

Status: **CONTRACT_HANDOFF** (development target, kernel 7.0.0-38-generic; G1 and GA 6.8 release certification remain PENDING_RUNTIME_PROOF).

## 1. Scope and Boundaries

- **Delivered components:**
  - `crates/arena-supervisor`: native Rust execution components:
    - `ipc`: length-delimited framed transport (u32 big-endian, max 1 MiB per frame).
    - `cgroup`: read-only cgroup-v2 accounting (`cpu.stat` integer `usage_usec`, `cgroup.events` `frozen`/`populated`).
    - `watchdog`: independent OS-thread CPU and wall deadline monitor with cancellation.
    - `control`: `CgroupControl` with post-freeze CPU sampling, verified freeze/unfreeze state, and verified `populated=0` kill.
    - `output`: byte-bounded Bot stdout (1 MiB), combined (2 MiB), retained stderr (64 KiB), and irreversible stdout closure on EOF.
    - `session`: `ExecutionSession` binding game ID, attempt ID, manifest digest, sequence numbers, request IDs, and message direction (`GameHost` vs `Supervisor`).
    - `reaper`: independent lease monitor over Unix socket; kills workload cgroup on supervisor disconnection/timeout.
    - `response`: post-freeze response resource budget evaluation.
    - `sandbox`: `Sandbox` managing runsc child process, non-blocking I/O pipes, watchdog, and cleanup.
    - `execution`: generated Protobuf codec from canonical `packages/protocol/proto/execution.proto`.
  - `packages/protocol`:
    - `proto/execution.proto`: versioned wire schema with discriminated `oneof` lifecycle messages.
    - `src/execution.ts`: generated TypeScript wire codec with string `uint64`.
  - `packages/runner`:
    - `src/game-host.ts`: trusted engine host coordinating INIT, turn requests, move validation, `applyMoveV2`, and `GameFinished`.
    - `bin/game-host.ts`: private Unix socket entrypoint for supervisor.
  - `packages/engine`:
    - `src/rules-v2.ts`: versioned v2 victory evaluation (`evaluateVictoryV2`, `applyMoveV2`), handling simultaneous breach NO_CONTEST, distinction of material/proximity/draw wins, and preserving v1 semantics in `rules.ts`.
  - `deploy/linux`:
    - `trusted-rootfs.Dockerfile` and `compiled-starters.Dockerfile`: reproducible rootfs builds.
    - `verify-rootfs.py`: read-only normalized tree integrity verifier.
    - `trusted-oci-spec.py`: fixed OCI 1.2 spec generator (read-only root, non-root UID 65534, network none, bounded tmpfs).
    - `smoke-cgroup-kernel.py`: dedicated kernel transition smoke.
    - `oantuti-dev-helper.py` + `.sudoers`: scoped helper for rootfs verification, controller, and reaper smokes.

## 2. Verification Evidence

- **Unit and component tests:**
  - `cargo test --tests --examples` in `crates/arena-supervisor`: 46 tests passed (17 suites, 0 failures).
  - `vitest run`: 128 tests passed across 31 test files (including protocol wire, rules-v2, and workspace validation).
  - Python tests (`tests/*_test.py`): 23 tests passed (cgroup kernel smoke, dev helper, gVisor smoke, rootfs verification, trusted OCI spec).
- **Integration smokes exercised:**
  - `verify-rootfs`: verified 15,036 rootfs members; normalized tree SHA-256 `b6305c27644a343ce1994b487e41bb1db46a332869b0f085c7b5f71a90d90d89` matched.
  - `smoke-controller`: verified freeze, unfreeze, and zero-descendant termination on transient child cgroup.
  - `smoke-reaper`: verified supervisor SIGKILL triggers independent reaper to terminate workload cgroup.
  - `gvisor-smoke`: verified runsc `release-20261005.0` executes `sleep 0` and cleans up without lingering mounts.
  - `three-language-match`: verified end-to-end matches in real gVisor sandboxes:
    - Python 3.12 SDK starter bot: PASS (1 ply, THRONE_BREACH, COMPLETED, reaper confirmed).
    - TypeScript compiled JS starter bot: PASS (1 ply, THRONE_BREACH, COMPLETED, reaper confirmed).
    - C++20 compiled binary starter bot: PASS (1 ply, THRONE_BREACH, COMPLETED, reaper confirmed).
  - Bot fault handling: verified invalid moves, syntax errors, and unexpected passes result in `BOT_FORFEIT` with opponent win; infrastructure errors fail-closed without awarding win.

## 3. Security and Quality Review Summary

- Two independent security reviews confirmed:
  - Scoped sudo helper grants only fixed commands with no caller-controlled arguments or paths.
  - Rootfs and executables are hashed in root-owned staging before deployment.
- Static lifecycle review caught a terminal CPU counter race (reading CPU before freeze confirmation); fixed by enforcing events-first sampling.
- Output collector review caught potential stdout reopening after EOF; fixed with irreversible stream closure.

## 4. Pending Gates (Explicitly NOT Complete)

- G1 execution certification: pending independent human security audit and GA 6.8 kernel baseline.
- Host: current workstation runs kernel 7.0.0-38-generic; physical GA 6.8 host certification remains pending.
- Untrusted submissions: development only; public code intake remains strictly closed.
- 500-team capacity and 72-hour endurance: pending S16/S17.

## 5. Next Session Prerequisite & Entry

- Gate for S03 met: sandbox launch, framed IPC loop, CPU accounting, independent reaper, and three-language starter execution functional.
- S03 Entry: PostgreSQL 16 schema migrations (`001-control-plane.sql`), identity and team management under `LAN_OFFLINE` profile, using the isolated development cluster already prepared in S01.
