# Native service commissioning security review

Date: 2026-10-26. Bounded source-contract review at `5855f2fc740f34f7413054b9d7ee0c6996f81bb9` (worktree `.git` → linked HEAD → branch ref inspected). No provisioning, migrations, DB changes, product edits, or runtime queue execution performed. Only this report was written. Disposable permission probes were explicitly authorized and removed automatically.

## Decision

**Do not commission the currently documented configuration as working.** Compiling the binaries and starting a delegated UID997 service does not resolve source-contract permission failures. UID997 (`arena-supervisor`) and API UID1000 are the commissioning identities supplied by this assignment and existing lifecycle evidence; they are not hardcoded in the binaries. Numeric socket GID984 in the old plan must be independently checked, not assumed.

`packages/server/src/jobs/local-trusted-native.ts` is absent in this checkout (direct read failed; filename glob also found no match). Do not invent its configuration or runtime behavior.

## Exact executable and identity contract

- API configuration `executable` means **arena-job-broker**, not arena-worker: `packages/server/src/jobs/runtime-config.ts:7-64`; `local-transport.ts:113-120` spawns it as `executable SOCKET WORKER_UID SOCKET_GID`. It inherits API identity and communicates through inherited framed pipes. Do not make it setuid or run the API as root.
- The broker CLI accepts exactly three positional arguments: `crates/arena-supervisor/src/bin/arena-job-broker.rs:1-7`. It binds without removing an existing socket, changes socket group and mode to0660, and authenticates Linux `SO_PEERCRED` UID/PID: `src/broker.rs:33-89`.
- Socket parent must be API-owned and not group/world writable (`local-transport.ts:115-116`). Provision an API-owned0750 parent with a dedicated socket group, worker search access, API membership permitting the broker's chgrp, and worker membership permitting connection. API needs no identity-switch privilege. Socket group access is not authentication: other UIDs remain denied by peer credentials.
- `OANTUTI_NATIVE_CONFIG` is an absolute regular file, owned by root or API UID, not group/world writable, <=64KiB; native and development execution are mutually exclusive (`runtime-config.ts:8-29`). Root-owned0640 is suitable only if API can actually read it. Required fields include all three toolchain identities and positive build/game gateway slot maxima (`:43-63`).
- **arena-worker is a separate supervised process**, connecting as worker UID997. Install **arena-reaper alongside arena-worker**, with immutable operator-owned binaries/ancestors: `src/sandbox.rs:216-226` derives its sibling path from current_exe. Broker-only installation cannot execute any queued work.

Actual worker command shape (capitalized values are operator-provided absolute paths/identities, not proposed installed defaults):

```sh
WORKER --broker-socket SOCKET --runsc RUNSC \
  --runtime-rootfs RUNTIME_ROOTFS --cgroup-root DELEGATED_CGROUP \
  --attempt-root WORKER_ATTEMPTS --runtime-profile-digest PROFILE_SHA256 \
  --max-game-slots 1 --max-build-slots 1 \
  --toolchains TOOLCHAIN_JSON --artifact-output-root WORKER_OUTPUT
```

`src/worker.rs:368-489` is the authoritative flag/environment contract. `--toolchains` is a filename containing an object keyed PYTHON/TYPESCRIPT/CPP, each with absolute `rootfs`, lowercase64-hex `imageDigest`, ASCII `version`, and ordered `flags`; it is **not** the API's toolchains array (`:145-254`). Python flags must include the intended syntax-check operation; TypeScript flags must be empty. Runtime uses fixed `/usr/bin/python3`, `/usr/bin/node`, `/usr/bin/g++`; no shell/PATH substitution (`src/materialize.rs:167-214`). Verify actual paths: `deploy/linux/trusted-rootfs.Dockerfile:3-8` puts Node under `/opt/node`, which alone does not satisfy `/usr/bin/node`.

## Blockers and minimal secure correction design

### 1. Cross-UID grant transport — confirmed source mismatch and exercised ACL failure

API creates per-attempt spool directories0700 and pinned grant files0600, owned by API UID1000 (`native-assignment.ts:350-387`). Worker directly opens the granted paths (`materialize.rs:227-255`). Socket GID membership cannot overcome these file modes. A default ACL is not a fix: explicit0700/0600 masks inherited named-user entries off.

**Minimal product correction to authorize separately:** use a dedicated grant-reader group shared only by API and supervisor. Add an explicit operator-owned grant GID option, validated against API supplementary/primary groups; do not infer it from request payloads. API-owned spool parent0710, per-attempt directory0750, grant file0640, each explicitly assigned that group before publishing the grant. Files remain API-owned and worker-readable, never worker-writable. Atomically write/chgrp/fchmod/fsync/rename before issuing path grants; fail closed if any step fails. Keep completion capsules/staged output/durable store private to API unless they actually contain grants the worker must read. Worker sends compiled bytes through bounded `stageArtifact`, so API does not need traversal of worker output. Do not give the worker broad filesystem-read capabilities, shared UID, or world-read access. A dedicated group is not a substitute for pinned size/digest verification.

### 2. Sandbox UID vs materialization — static failure risk, not exercised in runsc

OCI process is UID/GID65534, no additional groups (`materialize.rs:1402-1418`), while supervisor-created source files0600 and nested directories0700 are owned by supervisor (`:1321-1322,1706-1721`). Compiled game artifacts are0700 (`:1683-1693`). No user namespace or UID mapping is emitted (`:1434-1442`). Under ordinary unmapped filesystem identity semantics, UID65534 cannot read/execute these UID997 files. Do not call an resulting interpreter/file-access error a user SOURCE_REJECTED result.

**Minimal secure ownership design:** materialize each bot tree with intended sandbox UID65534 ownership and a dedicated supervisor-inspection group, directories0750, source0640, executable artifact0750. Output leaf should be owned by that intended UID and supervisor group with restrictive access, not0733 for arbitrary identities. Worker needs to read/hash artifacts and clean its own private attempt parent. Unprivileged UID997 cannot chown to65534: this is an explicit privileged prerequisite, not something Delegate=yes supplies. Prefer a reviewed root-owned, narrowly scoped materialization/launch mediator that receives already-validated fixed operations and owns only dedicated per-attempt roots; reject symlinks/traversal with dirfd-based resolution and never accept arbitrary host paths or commands. Alternative: a specifically reviewed user-namespace/runsc mapping mapping sandbox IDs to the supervisor's host-owned tree, preserving distinct API/worker identities. That alternative requires real runtime support and an operator-approved scoped AppArmor profile; none is configured by current source. Do not add ambient CAP_CHOWN/CAP_DAC_OVERRIDE or disable AppArmor globally. Parent must choose/authorize the implementation before provisioning.

### 3. C++ execute path — exercised kernel noexec denial, production runsc unexercised

Game C++ argv directly executes `/out/bot` (`materialize.rs:178-184`), but every read-only output mount has `noexec` (`:1367-1374`). Mode/ownership repair alone is insufficient. Remove `noexec` **only from the pinned, read-only executable-artifact mount**, retaining `ro,nosuid,nodev`; use a distinct artifact mount policy rather than making arbitrary writable output executable at game time. Keep source/workspace read-only. Confirm through real C++ BUILD→READY→GAME, not only Python.

## Privilege, resource and rootfs requirements

- A proper operator-provisioned service must run as UID997 with access only to its attempt/output/state roots, socket group and narrowly granted spool reads. Rootfs and installed binaries/config/toolchain documents must be immutable to API/worker; worker directories must be real directories, absolute, not group/world writable (`materialize.rs:1269-1283`). `ProtectHome=yes` makes a runtime installed under `/home/ha-thai` inaccessible: install immutable runtime outside home, not a permissive home exception.
- Delegate a cgroup v2 subtree, keep supervisor/reaper in an anchor subgroup, enable required controllers at empty internal nodes, and ensure descendants inherit controller availability. The worker only mkdirs attempt/side cgroups (`worker.rs:585-593,632-646`); it does not enable controllers. It must read cpu.stat/cgroup.events and write cgroup.freeze/cgroup.kill (`control.rs:29-36,79-84`). Never delegate the host/system.slice root or freeze the group containing the worker itself.
- **Delegate=yes is necessary, not sufficient.** Current OCI document emits only device resource denial, no memory/pids/cpu limits (`materialize.rs:1419-1443`); no supervisor source writes memory.max, memory.swap.max, pids.max, cpu.max or subtree_control. `runtime-profile.json:21-50` declares distinct compile/bot budgets, but assigning its SHA does not enforce them. A commissioning design must explicitly enforce per-workload limits from the pinned profile (and verify effective leaf values), not only service-wide ceilings. Profile certification remains `PENDING_RUNTIME_PROOF` (`:5`).
- Sandbox requires actual runsc namespace/mount capability under the host policy. It launches systrap, network=none, overlay2=none, fresh gofer network namespace, strict sidecar checks, cleared environment (`sandbox.rs:277-286`). OCI requests fresh pid/ipc/uts/mount/network namespaces, no user namespace, no bot capabilities, no-new-privileges (`materialize.rs:1404-1443`). No exact host capability allowlist can honestly be certified from source alone. Review scoped runsc launch mediation/AppArmor with administrator approval; no Docker runtime privilege workaround or global policy relaxation.
- Existing rootfs installer verifies archive checksum, normalizes ownership, and checks exact normalized tree (`deploy/linux/verify-rootfs.py:33-106`; `install-three-language.sh:8,40-55`). Archive digest and normalized-tree digest are different identities. Verify each configured runtime/toolchain image against its actual archive/tree and measured version. The worker matches declared toolchain identity/version (`worker.rs:145-169`); it does not recompute a rootfs tree merely because imageDigest appears in JSON. Existing trusted fixtures and smoke grants do not authorize arbitrary worker services (`deploy/linux/oantuti-dev-helper.sudoers:1-2`).

## Exercised evidence

Only unprivileged disposable probes under UID1000:

1. chmod000 file read returned EACCES(errno13), then mode restored for cleanup.
2. Default ACL `d:u:997:r-x,d:m::r-x`, followed by mkdir0700/open0600, produced `user:arena-supervisor:r-x #effective:---`, `mask::---` on both new attempt directory and grant. This directly reproduces ineffective default ACLs under the production creation modes.
3. Copying `/usr/bin/true` mode0700 into `/run/lock` (confirmed noexec mount from `/proc/mounts:9`) then executing returned EACCES(errno13). Initial probe under `/dev/shm` succeeded because that mount is executable (`/proc/mounts:8`); this was a probe-precondition correction, not evidence against noexec enforcement.

Actual UID997 switch, UID65534 access, runsc behavior, service startup, and real queue execution were **not exercised**. Their findings above are explicitly source-derived, not claimed runtime failures.

## Acceptance and safe rollback for commissioning owner

Commands below are acceptance instructions, **not executed evidence**. Administrative identity-switch/service operations require the existing secure authorization workflow; no password capture or sudo whitelist expansion is proposed. Substitute actual reviewed paths/unit/GID and scope all DB reads to `arena_closure_20261026_030157_test`.

```sh
getent passwd arena-supervisor
getent group REVIEWED_GRANT_GROUP
stat -c '%u:%g %a %n' CONFIG SOCKET_PARENT WORKER_ATTEMPTS WORKER_OUTPUT
namei -l ACTUAL_NEW_GRANT
getfacl -cp ACTUAL_ATTEMPT_DIRECTORY ACTUAL_NEW_GRANT
systemctl show REVIEWED_UNIT -p User -p Group -p SupplementaryGroups -p Delegate -p ControlGroup -p KillMode
systemctl status REVIEWED_UNIT --no-pager
journalctl -u REVIEWED_UNIT --no-pager
```

Administrator-run identity tests must show worker997 can read actual freshly created grants and cannot modify them; unrelated UID cannot read them. Supervisor cannot access API secrets or write immutable binaries/rootfs. Confirm runtime UID65534 can read its sources/execute pinned artifact but cannot read another attempt. Inspect every workload leaf's `cpu.max`, `memory.max`, `memory.swap.max`, `pids.max`, `cgroup.events`, `cpu.stat`, parent `cgroup.subtree_control`; confirm freezer and kill transitions and empty descendants after teardown. Check runsc list under each explicit state directory is empty after completion/failure.

Readiness is not a kernel proof: `local-transport.ts:94-101` advertises capabilities from an authenticated claim/heartbeat seen within30s and matching digest, before a successful workload. Worker startup validates configuration but not all runtime paths (`worker.rs:292-333,1820-1828`), and one process handles one attempt at a time (`:1794,1858-1868`). Initially configure one build and one game offer within gateway maxima; do not mistake advertised counts for concurrency.

Final acceptance must include isolated API15611/web15612 with development executor off; real submission build reaches READY with measured probe/compile/INIT and pinned artifact; real official GAME completes with accepted native result/replay and termination evidence. Include C++ as well as interpreted runtime coverage. Query jobs/attempts/completions/submissions/games/results read-only in the isolated DB and preserve exact IDs/digests. Smoke helpers alone are insufficient.

For stop/rollback, stop new claims first, allow the current bounded attempt to finish where possible, then stop only the new worker unit. Keep its independent reaper alive until kill/delete/empty-cgroup confirmation (`sandbox.rs:216-226`); do not assume process-group death invokes Rust Drop cleanup. Use bounded operator-supervised service stop and verify no populated workload descendants/runsc state remain; if cleanup cannot be proved, quarantine rather than restart/claim again (`worker.rs:1835-1844`). Stop native API transport (its stop removes only its recorded socket inode, `local-transport.ts:158-168`) before reconfiguring that API. Leave expired attempts for normal lease reconciliation; never force READY, reset shared DB, or delete evidence. Remove only newly installed unit/config/runtime objects after service/runtime cleanup is proven. Preserve restrictive existing sudoers, AppArmor and unrelated services. Review systemd KillMode/stop ordering against reaper survival explicitly; copying the smoke service's control-group kill without this proof is not a production teardown design.

## Authorized correction implementation plan

Parent authorized product correction after this review; no administrative runtime action is implied.

1. **TS grant transport — closure-evidence owns:** thread required `grantGid` through runtime-config → LocalJobBrokerOptions → assignment options; atomically publish API-owned, explicitly group-assigned0750 attempt directories/0640 grant files, validate API group membership. Tests pin fresh modes/group and deny writes/unrelated identities. Keep capsules private. No overlapping Rust edits.
2. **Rootless identity/executable mount — native-service-review owns:** retain supervisor-owned0700/0600 materialized trees. Emit fresh OCI user namespace, single UID/GID mapping container0→effective supervisor UID/GID, process0:0, empty capabilities/noNewPrivileges. Add `--rootless` at the sole runtime command site. This uses runsc's existing rootless model, not privileged chown/new helper/shared API UID. Root exists only inside mapped namespace. Operator must approve scoped installed-runtime AppArmor userns permission; no global policy weakening. Remove `noexec` only from read-only pinned artifact mount. `tests/worker_materialize.rs` pins maps, private host permissions, capabilities and executable mount; sandbox unit tests pin rootless invocation.
3. **Resource enforcement — same Rust owner:** use existing ArenaRuntime/v1 fixed values in OCI resources and rlimits, distinguishing compile/probe (CPU100000/100000, memory1073741824, swap0, pids64, files128) and bot/INIT (CPU100000/100000, memory268435456, swap0, pids32, files64). Configure required cpu/memory/pids controllers at empty delegated internal cgroups before creating leaves; write/read-back exact leaf limits before any launch, including rootless runtime which may otherwise skip cgroup-install errors. Reuse control.rs and existing materialize/worker paths; fail infrastructure on any mismatch, never accept source verdict. Tests pin OCI values and leaf preparation/readback behavior with disposable filesystem fixtures, with real kernel proof reserved for authorized service.
4. **TDD/integration:** add failing regressions before implementation; run Rust tests via cached Docker compiler if host toolchain unavailable (compiler only, never privileged runtime). Update existing callers/tests and this report. Parent integrates TS+Rust, then runs isolated real BUILD→READY and official GAME after secure administrative authorization. No commits or UI edits. Namespace/host-service validation remains an explicit commissioning prerequisite, not a passing unit-test claim.

## Rust correction implementation and evidence

The preceding review describes the original5855f2f source; this section supersedes its proposed privileged ownership mediator and UID65534 commissioning checks. The parent approved the existing rootless runtime model instead: container0 maps exactly to OS `geteuid()`/`getegid()` of the separate supervisor, without subuid helpers/chown, empty capabilities and no-new-privileges. Materialized source/state/output remain0700/0600, including removal of the old0733 output leaf. No shared API/supervisor UID or world-readable source is introduced.

Implemented in `crates/arena-supervisor/src/materialize.rs`, `sandbox.rs`, `control.rs`, `worker.rs`, and `bin/arena-reaper.rs`, with regressions in `tests/worker_materialize.rs`, `tests/worker_build.rs`, and module unit tests:

- Fresh OCI user namespace with single OS-derived UID/GID mapping; installed runsc rootless flag on launch and independent reaper cleanup.
- Read-only executable artifact mount no longer has noexec; C++ workspace mount exists even when execution uses a compiled artifact.
- Compile/probe and bot/INIT fixed ArenaRuntime/v1 resource constants shared between OCI emission and explicit kernel limit write/readback. Missing controllers, populated internal cgroup, symlinked/missing limit files, or unequal readback fail closed before launch. Operator still provisions an empty delegated root with the supervisor/reaper in an anchor subgroup. The worker enables cpu/memory/pids at empty root/attempt internals.
- Profile digest remains the SHA-256 of the exact pinned runtime-profile JSON, never a rootfs tree hash. Values are the existing ArenaRuntime/v1 fixed schema constants, not a new arbitrary config surface. OCI memory.swap is memory+swap (equal to memory limit); kernel memory.swap.max is0. This does not certify the entire profile or prove host enforcement without live acceptance.
- Newly confirmed runtime defect: layouts previously passed a JSON **file** to `runsc --bundle`, which expects a **directory/config.json**. Materializer now creates private per-command run/compile/toolchain directories containing verified0600 config.json and passes those directories. The permanent consumer tests load `layout.bundle/config.json`; scripted workers alone had not caught the real CLI contract mismatch.

Installed runtime evidence: `/usr/local/libexec/oantuti/gvisor-20261005.0/runsc --version` reports `release-20261005.0`, OCI spec1.2.1. Its `flags` output explicitly supports `--rootless`; no TESTONLY/ignore-cgroups flags are used. Disposable unprivileged real-runsc parsing probe returned `not a directory` when given config.json as --bundle, but advanced past FetchSpec to rootless network-policy validation for a proper directory. This proves the parsing boundary, **not** successful namespace creation or workload execution.

TDD evidence: initial materializer regression run failed the three intended assertions (UID65534≠0, noexec present, resources missing). Rootless command regression failed on absent --rootless. Resource regression initially failed to compile because WorkloadLimits was not implemented; subsequent tests exercise real file writes, missing-file rejection, unequal readback and populated/missing-controller rejection. Consumer bundle regression returned test-failed before correcting the directory contract (tool output suppressed the assertion detail). Private-output regression returned test-failed before changing0733→0700. First complete-suite run exposed an old test expecting a workload leaf despite unavailable controllers; updated expectation now pins earlier failclosed behavior.

Final exercised command: Docker compiler-only `cargo test -p arena-supervisor`, captured exit0; all unit/integration/doc-test groups passed (22 library tests and all listed integration groups). The negative reaper test emits an expected `Os { code:2, NotFound }` child diagnostic while both reaper tests pass; this is not hidden as pristine output. The first compiler attempt lacked protoc; an ephemeral ordinary compiler container installed protobuf-compiler, with no host provisioning or runtime privilege. No native service/DB/queue execution was performed.

**Still mandatory before commissioning:** secure admin authorization; scoped AppArmor userns authorization for the immutable installed runtime executable and required reviewed companion transitions; real rootless filesystem ownership/exec behavior; exact effective leaf limits and freezer/counter/kill proof; reaper survival and teardown; measured rootfs/toolchain identities; isolated BUILD→READY and official GAME including C++. Tests and capability advertisements are not a sandbox safety/readiness certification. The TS grant group correction and reviewed installer belong to closure-evidence; parent must integrate both slices before live acceptance.

### Final raw evidence and exact file ownership

Raw full stdout/stderr and explicit exit code are saved in `docs/qa/native-service-cargo-test.log` (latest run exit0,23 library tests plus all integration/doc-test groups). The added `fixed_workload_limits_match_the_pinned_runtime_profile` test reads the repository profile via include_str and checks revision plus both memory/swap/pids/files/CPU values against Rust constants. This regression passed immediately because it pins the corrected existing constants; no new behavior is claimed from it.

**Digest boundary:** current exact JSON SHA256 is `719b93dc11c56b1ab7f1bffee1b20b58107a981e59d9c061408c5d329cf931e7`. WorkerConfig still accepts any syntactically valid64-hex profile digest; matching gateway/worker arbitrary hashes do not prove equality to these fixed constants. Installer/service configuration must compute and check this reviewed exact profile digest before emitting API/worker config. Supporting a different profile requires a reviewed constants/schema change and equality test update, not editing a hash alone. This limitation was sent to the commissioning owner; rootfs identity is never substituted.

Exact files touched by this Rust/review workstream:

- `crates/arena-supervisor/src/materialize.rs`
- `crates/arena-supervisor/src/sandbox.rs`
- `crates/arena-supervisor/src/control.rs`
- `crates/arena-supervisor/src/worker.rs`
- `crates/arena-supervisor/src/bin/arena-reaper.rs`
- `crates/arena-supervisor/tests/worker_materialize.rs`
- `crates/arena-supervisor/tests/worker_build.rs`
- `docs/qa/native-service-security-review.md`
- `docs/qa/native-service-cargo-test.log`

No TS files, installer, service units, migration, runtime-profile JSON, or policy files were edited by this workstream. Shutdown retains supported runsc delete/force flags and the same rootless flag verified in installed flags output; real cleanup/namespace behavior remains a live administrative acceptance prerequisite.
