#!/usr/bin/env bash
# Operator runs this reviewed bootstrap once. Never sudo a mutable repo script.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run in an authenticated root terminal.' >&2; exit 1; }
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
src=/home/ha-thai/.local/share/oantuti/development/helper-v1-payload
bundle=/usr/local/libexec/oantuti/dev-helper-v1
helper=/usr/local/sbin/oantuti-dev-helper-v1
policy=/etc/sudoers.d/oantuti-dev-helper-v1
for target in "$bundle" "$helper" "$policy"; do
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "Refusing existing target: $target" >&2
    exit 1
  fi
done
stage=$(mktemp -d /var/tmp/oantuti-helper-install.XXXXXXXX)
# Copy first; hash only root-owned staging, never execute mutable source inputs.
for name in helper verify-rootfs.py smoke-cgroup-kernel.py controller reaper manifest.json sudoers; do
  install -o root -g root -m 0600 "$src/$name" "$stage/$name"
done
(cd "$stage" && sha256sum --check <<'HASHES'
962825e4f72fb6f3a0f7050bee391ed09ad6d05cea00f9c9998fe4c894c8d441  helper
8b8736ae7040c8f3d232e1024dbedbbaa66e93c35b7b593e7334295e270c1a6c  verify-rootfs.py
34aa7a468fc27bbaec215449ca5eb3f3798646267c0c971d0dbb54881fa71f2e  smoke-cgroup-kernel.py
66eb99a077c3e375f3ad08920b39abd706f76e3a2cda6b9701d4f6cc6a01f9ea  controller
93c9782d898f2ab0ccceb4c0ff58ca8c346c5ee929f4d7650d5e1dc18e9c971a  reaper
2818b43dfa47c34697274e599b44fb92b0be9640a9c203bac960de91598c5512  manifest.json
62c646f09446421800414655d4846e11380dbcfe9f8ee4188ea2cd6dc3b466a5  sudoers
HASHES
)
install -o root -g root -m 0600 /var/tmp/oantuti-rootfs.OzAJiabS/rootfs.tar "$stage/rootfs.tar"
printf '%s  %s\n' 63768f52c0ba59396b40aabfa6ced7650d5f7b309ba09d9e606b7189eb3865b4 "$stage/rootfs.tar" | sha256sum --check -
visudo -cf "$stage/sudoers"
# Refuse writable/symlink ancestors rather than changing existing permissions.
/usr/bin/python3 -I -c 'import os,pathlib,stat
for value in ("/usr/local/sbin", "/usr/local/libexec/oantuti", "/etc/sudoers.d"):
 p=pathlib.Path(value)
 for q in [p,*p.parents]:
  s=q.lstat()
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or s.st_mode & 0o6022: raise SystemExit("Unsafe install ancestor")'
install -d -o root -g root -m 0755 "$bundle"
for name in verify-rootfs.py smoke-cgroup-kernel.py controller reaper; do
  install -o root -g root -m 0755 "$stage/$name" "$bundle/$name"
done
install -o root -g root -m 0644 "$stage/manifest.json" "$bundle/manifest.json"
install -o root -g root -m 0600 "$stage/rootfs.tar" "$bundle/rootfs.tar"
install -o root -g root -m 0600 /dev/null "$bundle/operation.lock"
install -o root -g root -m 0755 "$stage/helper" "$helper"
# Enable policy last. On validation failure remove only the new policy.
install -o root -g root -m 0440 "$stage/sudoers" "$policy"
if ! visudo -c; then
  rm -- "$policy"
  exit 1
fi
printf 'Installed scoped helper. Revoke access: sudo rm -- %s\n' "$policy"
printf 'Staging retained: %s\n' "$stage"
