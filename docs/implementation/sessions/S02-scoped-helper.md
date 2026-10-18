# S02 — Scoped operator helper

Status: **INSTALLED_SCOPED_ACCESS_VERIFIED; ROOTFS_VERIFIED**. Agent exercised approved helper actions; after operator repaired eight directory modes, exact normalized rootfs verification passed. No gVisor launch permission is included in this helper version.

## Authorized scope

Operator selected fixed root-owned helper + separate sudoers instead of general passwordless sudo. Never supply a password through chat or agent tool input.

- Root entrypoint: `/usr/local/sbin/oantuti-dev-helper-v1`.
- Root payload directory: `/usr/local/libexec/oantuti/dev-helper-v1`.
- Policy: `/etc/sudoers.d/oantuti-dev-helper-v1`.
- Exactly three actions: `verify-rootfs`, `smoke-controller`, `smoke-reaper`.
- No caller paths/extra args, shell, general runsc/systemd/python permission, installer/update action, or gVisor launch action.
- Fixed environment, isolated Python, protected bundle checksums, root-owned nonwritable ancestors, serialized execution.

Files: [helper](../../../deploy/linux/oantuti-dev-helper.py), [policy](../../../deploy/linux/oantuti-dev-helper.sudoers), [one-time installer](../../../deploy/linux/install-dev-helper.sh).

## Prepared payload and integrity

User-local payload: `/home/ha-thai/.local/share/oantuti/development/helper-v1-payload`. Installer copies to root-owned staging before checking pinned hashes; it never executes source payload from the developer directory. Existing installation destinations cause refusal, not overwrite. Archive SHA256 remains `63768f52c0ba59396b40aabfa6ced7650d5f7b309ba09d9e606b7189eb3865b4`; copied root-owned into bundle for repeat verification.

Installer SHA256 at preparation: `6e470aba839a325dc8975234f5fec030d4c65cbc43aaf9808e204f86290d47e2` (check current source before operator installation; changes invalidate this receipt).

## Exercised verification

- `bash -n deploy/linux/install-dev-helper.sh`: exit0.
- `visudo -cf deploy/linux/oantuti-dev-helper.sudoers`: parsed OK, exit0.
- Four helper Python tests passed: arbitrary action/extra arguments denied, fixed interpreter/path mapping, tampered bundle rejected before child execution.
- Four kernel-smoke Python regressions passed.
- Actual nonroot helper CLI: `REJECTED / ROOT_AUTHENTICATION_REQUIRED`, exit1.
- Install ancestors `/usr/local/sbin`, `/usr/local/libexec/oantuti`, `/etc/sudoers.d` observed root:root0755.
- Two independent read-only reviewers (helper/sudoers and bootstrap/child lifecycle) found no actionable privilege-escalation or unsafe-overwrite blocker. Both require independently copying and verifying the installer itself into root-owned private staging before executing it; embedded payload checks do not authenticate a mutable installer. Partial failures may leave artifacts, never auto-overwritten or deleted on retry.

No automatic permission granted by these tests. Normalized rootfs digest, repeated smoke via installed helper, launcher/reaper/gVisor integration remain pending until actual execution.

Continuation: `/usr/local/sbin/oantuti-dev-helper-v1` executable-presence check failed; verification action was not run. Operator installation remains pending, no passwordless authority assumed. Fixed [trusted-oci-spec.py](../../../deploy/linux/trusted-oci-spec.py) prepared independently: only sleep0, known promoted rootfs read-only, UID/GID65534/no capabilities/no-new-privileges, private namespaces/no host binds, tmpfs16MiB, memory256MiB/no extra swap, pids32/nofile64/one-core entitlement. Three behavioral schema tests and actual JSON CLI passed. This is OCI configuration, **not an implemented launcher or isolation proof**; no cgroup path assignment/runsc execution, normalized-tree digest or rootfs/helper installation gate bypass. No gVisor action added to helper policy or pinned payload.

Operator installation output: all pinned payload/archive hashes OK and new policy parsed OK; global `visudo -c` reported `/etc/sudoers.d/agent-auto-install` bad permissions (expected0440). Read-only stat confirms that unrelated policy root:root0644; OanTuTi helper/prefix root:root0755 and OanTuTi policy absent, consistent with installer rollback. Conflicting file grants ha-thai NOPASSWD apt/apt-get/dpkg as ALL users. Do not auto-fix mode or exercise those broad package-manager privileges: making policy active is a separate security decision, package managers permit privileged code execution. No permissions changed or alternate sudo route attempted. Do not rerun whole bootstrap: targets now exist and are intentionally protected from overwrite. Recovery needs an operator decision on the unrelated policy, then validation and install only the already-verified scoped OanTuTi policy.

Operator explicitly selected retaining auto-install policy after disclosure that passwordless apt/apt-get/dpkg can execute privileged code. Authorized recovery scope: change only that existing policy mode to0440 after checking known contents/root ownership, validate allsudoers; then reinstall only pinned OanTuTi sudoers from verifiedrootstaging. Agent will not use package-manager authority for privilege escalation. Root authentication still required for recovery; no chmod/policy installation performed by agent at this point.

Actual agent helper execution after operator recovery: `verify-rootfs` exit1 with MODE_MISMATCH; no failure suppressed. Read-only archive/mode comparison found eight directories differ from specified archive-mode &01755 normalization: etc/ssl/private0700→actual0755, home/ubuntu0750→0755, root0700→0755, run/lock01755→0755, tmp01755→0755, var/cache/apt/archives/partial0700→0755, var/cache/ldconfig0700→0755, var/tmp01755→0755. Earlier promotion verifier checked only forbidden bits, not exact modes; its PASS does not establish the stricter normalization contract. No rootfs writes performed by helper or agent. Do not weaken exact-mode validation to accept widened directory access.

Agent directly ran approved `smoke-controller` and `smoke-reaper` via scoped helper: both PASS on kernel7.0.0-38, zeroDescendantsConfirmed=true; controller freeze/unfreeze confirmed, reaper supervisorSigkillConfirmed=true. Units respectively oantuti-kernel-smoke-0cee622a5622407992e6cb44052fd974.service and oantuti-kernel-smoke-a096b0df1ff34c0e8ca82e74e536c4f3.service. botExecuted=false/gvisorCertified=false. Scope does not include chmod/rootfs repair or gVisor launch; directory-mode repair needs operator action before verify-rootfs can produce normalized digest. No apt/dpkg privilege used.

After operator confirmed directory-mode repair, agent ran `sudo -n /usr/local/sbin/oantuti-dev-helper-v1 verify-rootfs`: exit0, status VERIFIED, 15,030 members. Archive SHA256 unchanged; normalizedTreeSha256 `7a86c93baf6ff2407ebdbfa85715f3542b6b5c1a07a481dd4c3f1cfb14392d78`. [Durable receipt](S02-rootfs-verification.json). Earlier mode mismatch remains historical evidence, now resolved without weakening validation. This proves normalized artifact contents/permissions at verification time, not immutable future state, gVisor containment, workload execution or release certification. Existing three-action sudo policy unchanged.

## Revocation

Operator may revoke only the new policy:

```bash
sudo rm -- /etc/sudoers.d/oantuti-dev-helper-v1
sudo visudo -c
```

This removes unattended sudo access without deleting artifacts or unrelated policies. No `NOPASSWD: ALL`, timestamp-policy changes, kernel changes, or external exposure.
