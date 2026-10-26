# Native commissioning checkpoint — 2026-10-26

**Status: corrected installer independently cleared for INSTALLATION ONLY; not installed, no runtime certification.** Original unsafe draft was never executed. Independent review: `native-commissioning-install-review.md`. Workspace `/home/ha-thai/orca/workspaces/OanTuTi/develop-online-v2-2`, observed HEAD `5855f2fc740f34f7413054b9d7ee0c6996f81bb9`.

## Authorization evidence

Dedicated commands in this resumed worker returned:
- `sudo -n true`: exit 1, `sudo: a password is required`.
- `sudo -n -v`: exit 1, same stderr.
- `sudo -n chroot ... /usr/bin/python3 --version`: exit 1, same stderr.

An earlier combined-command observation was incorrectly interpreted as proof of cached general authorization; it is superseded by these exact dedicated results. `sudo -n -l` permits password-authenticated `(ALL : ALL) ALL`, NOPASSWD apt/apt-get/dpkg and six existing fixed development helper commands. These do **not** authorize arbitrary commissioning commands without authentication. No privilege bypass, global sudoers/AppArmor lowering, installation, service restart, or shared database mutation has occurred in this resumed work.

## Measured inputs

- API account: `ha-thai`, UID/GID 1000; current groups do **not** contain 984.
- Worker account: existing `arena-supervisor`, UID997/GID984, nologin.
- systemd255 (Ubuntu 255.4-1ubuntu8.18); proposed `DelegateSubgroup=anchor` must pass unit validation.
- Existing root-owned runsc `/usr/local/libexec/oantuti/gvisor-20261005.0/runsc`, release-20261005.0, SHA256 `210b437a9cfae51e8f8c9074ed19b8b5e59477178e2e391a18117d8d6b924f7a`.
- Compiler rootfs `/var/lib/oantuti/development/rootfs/fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb`. Installed archive is root-private; full normalized-tree verification requires authorized read. Do not confuse compiler rootfs with runtime-only `63768...`.
- Read-only, network-disabled nonprivileged Docker mount of compiler tree measured Python3.12.3 (rootfs library path), Nodev24.22.0, g++13.3.0. These are executable version observations, **not** complete sandbox/rootfs integrity proof.
- `deploy/linux/runtime-profile.json` SHA256 `719b93dc11c56b1ab7f1bffee1b20b58107a981e59d9c061408c5d329cf931e7`; fixed resource profile remains `PENDING_RUNTIME_PROOF`.

## Required corrections and exercised tests

`grantGid` is required in nativeGatewayConfig and NativeAssignmentOptions; optional `writeGrant` parameter is intentional for private completion capsules0600. Runtime config checks API group membership. Added direct assignment/spool membership checks and fail-closed existing spool ownership/mode/symlink validation, removing swallowed chmod/chown failures.

New regression tests first failed for all three real defects: symlink target mutated, group-writable spool accepted, and nonmember group created spool before failure (`artifact://2912`). After correction `native-grant-permissions.test.ts`: **10 passed**, exit0. No database was used for this test.

Fresh native acceptance slice on a clean dedicated owner-role test DB: **34 passed, five files passed, exit0**, raw `native-commissioning-acceptance.log`. Earlier empty-schema, wrong owner credential, app-role cleanup privilege, and contaminated prior-fixture FK failures remain in logs, classified as setup/fixture failures rather than hidden. The final default application-role suite uses a new timestamped disposable DB with official migrations and explicit test-only table/sequence/schema grants plus outbox_events ownership; output is written from process start to `native-commissioning-default-suite.log`. A prior eval-interrupted run produced no recoverable result and is not claimed as passing. Actual grant smoke `native-commissioning-grant-smoke.log` records UID1000/GID1000 modes parent0710/attempt0750/grant0640/private capsule0600. This does not prove the pending cross-identity984 runtime path. Actual permission10/typecheck/shell-syntax and non-loading AppArmor parser results are in `native-commissioning-unprivileged.log`. Extracted unit verification rejects only the not-yet-installed executable, so full unit verification is not claimed. Latest Rust consumer/CPU corrections and full Rust exit0 evidence are owned by independent reviewer (`native-commissioning-evidence/cargo-suite.log`); all three release binaries were rebuilt afterward, hashes recorded in `native-commissioning-release.json`.

## Reviewed deployment contract (not yet installed)

Use only a new isolated prefix (`oantuti-qa-native`), not shared demo directories/services. API remains UID1000/GID1000 with process-scoped supplementary984; worker stays997:984 without group1000 access. No global user group changes. API-owned grants0710/attempt0750/files0640 are separate from worker-private attempts/output0700 and API-owned compiled artifact store. Config ancestor root:9840750 allows both intended identities; files root:9840640.

Installer must snapshot into root-owned private staging, hash **staged** files, reject symlinks/unsafe ancestors and existing targets, verify archive/tree and exact versions, atomically publish immutable binaries/config, and attach narrowly scoped AppArmor userns permission to immutable installed runsc only. Unit delegates cpu/memory/pids on its own new subtree, keeps service parent empty with an anchor subgroup, derives its cgroup from `/proc/self/cgroup`, uses `KillMode=mixed`, bounded stop timeout and `Restart=no`. Rootless OCI process0 maps to host worker997:984; it does not run host nobody65534.

Corrected installer includes a fixed root-owned isolated API launcher using `runuser` with supplementary984 and cleared inherited environment; the private API launcher pins isolated DB15621/dev-executionOFF and preserves supplied native config. No credentials enter installer arguments. The unit uses private `TemporaryFileSystem` output512MiB with execute allowed for C++ INIT; actual namespace mount/ENOSPC proof remains pending. Unprivileged script execution refuses with exit1 before mutation. Reviewer corrected conditional compile/INIT cgroup reuse, aggregate compile CPU budget, and compile RLIMIT10; these source/test results are not proof of kernel runtime behavior. FINAL installer SHA256 `a64e2e939ce883ef0eef4841f9c3709c513e042a9d9cba48c32592d1f455938d`; reviewer verified all final rebuilt binary pins and cleared source for bounded INSTALLATION ONLY.

Actual BUILD→READY and official GAME including C++, effective leaf limits, freezer/counters, and worker-death reaper cleanup remain **unexercised**. No readiness or recovery claim may be inferred from capability advertisements or unit tests. Read-only `ss` observed listeners API15621/web15622/TLS15623; prior15611/15612 process claims are stale. No shared database reset or process restart was performed by this worker. The remaining prerequisite is secure administrative authentication for the independently reviewed bounded installer; no password should be provided in chat or tool arguments.

## Final exercised result and secure operator step

Final fresh application-role default suite: **744 passed, 43 skipped; 121 files passed, 5 skipped; exit0** (`native-commissioning-default-suite.log`). Prior missing-grantGid fixture failure remains in `native-commissioning-default-before-fixture-fix.log`; its caller is migrated. Rust reviewer final suite:136 passed, exit0, separate raw evidence. No skipped/gated tests are represented as passing.

Run locally, with the sudo password entered only into the terminal prompt:

```bash
cd /home/ha-thai/orca/workspaces/OanTuTi/develop-online-v2-2
sudo bash deploy/linux/operator-commission-worker.sh
```

The installer requires the exact three pinned release binaries already built in `/tmp/oantuti-native-bin`; absent/changed binaries fail closed during root-private snapshot/hash validation. It starts nothing. After successful installation, the isolated runtime owner must stop ONLY `isolated-lifecycle-api` (not web/TLS/shared services), launch `/usr/local/libexec/oantuti/qa-native-20261026/launch-api` with administrative authorization, then `sudo systemctl start oantuti-qa-native.service`. Verify actual API UID1000/supplementary984, worker997:984 and all bounded acceptance before reporting native ready. Never start a second API while port15621 is occupied. Current actual target is tournament `17d518be-2a9e-458f-9341-2e407156e7ec`, genuine queued submissions still VALIDATING/zero attempts; lock409 INTAKE_DRAINING and start503 NATIVE_EXECUTION_NOT_READY are honest precommissioning guards, not passed downstream lifecycle. See separate `isolated-rerun-evidence.md` for full IDs/browser evidence.
