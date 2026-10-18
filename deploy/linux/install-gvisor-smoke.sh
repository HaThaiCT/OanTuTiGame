#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" = 0 ] || exit 1
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
src=/home/ha-thai/.local/share/oantuti/development/gvisor-smoke-payload-v1
dst=/usr/local/libexec/oantuti/gvisor-smoke-v1
policy=/etc/sudoers.d/oantuti-gvisor-smoke-v1
for p in "$dst" "$policy"; do
  if [ -e "$p" ] || [ -L "$p" ]; then echo 'Target exists; refusing overwrite.' >&2; exit 1; fi
done
stage=$(mktemp -d /var/tmp/oantuti-gvisor-install.XXXXXXXX)
for name in smoke-gvisor.py trusted-oci-spec.py sudoers; do
  install -o root -g root -m 0600 "$src/$name" "$stage/$name"
done
(cd "$stage" && sha256sum --check <<'HASHES'
df37e968c8b491cffa25ad0ba877f8fd52a50456a4ce1ef2fe9696eb44290676  smoke-gvisor.py
7a9a6f0caa5fa43888947d1e024f21e2e84bc690685f6c7529c15874041312b0  trusted-oci-spec.py
c194bfb1b3f892067828f61a11935c646bb0474cc11ac686b01e460a0c921e91  sudoers
HASHES
)
/usr/bin/python3 -I -c 'import pathlib,stat
for value in ("/usr/local/libexec/oantuti", "/etc/sudoers.d"):
 p=pathlib.Path(value)
 for q in [p,*p.parents]:
  s=q.lstat()
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or s.st_mode&0o6022: raise SystemExit("Unsafe ancestor")'
visudo -c
visudo -cf "$stage/sudoers"
install -d -o root -g root -m 0755 "$dst"
install -o root -g root -m 0755 "$stage/smoke-gvisor.py" "$dst/smoke-gvisor.py"
install -o root -g root -m 0644 "$stage/trusted-oci-spec.py" "$dst/trusted-oci-spec.py"
install -o root -g root -m 0440 "$stage/sudoers" "$policy"
if ! visudo -c; then rm -- "$policy"; exit 1; fi
echo 'FIXED_GVISOR_SMOKE_INSTALLED'
echo 'Revoke: sudo rm -- /etc/sudoers.d/oantuti-gvisor-smoke-v1'
