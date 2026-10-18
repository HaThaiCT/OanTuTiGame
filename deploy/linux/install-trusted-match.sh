#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[ "$(id -u)" = 0 ] || exit 1
src=/home/ha-thai/.local/share/oantuti/development/trusted-match-payload-v1
dst=/usr/local/libexec/oantuti/trusted-match-v1
policy=/etc/sudoers.d/oantuti-trusted-match-v1
for p in "$dst" "$policy"; do
 if [ -e "$p" ] || [ -L "$p" ]; then echo 'Target exists; refusing overwrite.' >&2; exit 1; fi
done
stage=$(mktemp -d /var/tmp/oantuti-match-install.XXXXXXXX)
for name in trusted-match.py supervisor config.json start.pb manifest.json sudoers; do
 install -o root -g root -m 0600 "$src/$name" "$stage/$name"
done
(cd "$stage" && sha256sum --check <<'HASHES'
413cc8655aaac2e2e3617d39f81825a0974ea0a20255428f2d74bbdbf60c55de  trusted-match.py
67adc5a0c7ffcc1b04be37cc149373308deaa12062227e90b97be9de2a2da0be  supervisor
b7c18e2b4027c66745eb02008c8f9005dbb244f2886d4f0fba60dd18142bd6d1  config.json
bfc23d5ef5e175f030aaf00d8ebd45f863097f60941582ba359ee8b2576b49e8  start.pb
72759489ca5b38ddefa14854f5c6d17296cfbb79f82b5496100df1647cf4acb7  manifest.json
7eb1a047487373f3c77e5360a60f3a3beef1d2fca4c8af3f2cbf5ff2cbe2b715  sudoers
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
for name in trusted-match.py supervisor; do install -o root -g root -m 0755 "$stage/$name" "$dst/$name"; done
for name in config.json start.pb manifest.json; do install -o root -g root -m 0644 "$stage/$name" "$dst/$name"; done
install -o root -g root -m 0440 "$stage/sudoers" "$policy"
if ! visudo -c; then rm -- "$policy"; exit 1; fi
echo TRUSTED_MATCH_INSTALLED
