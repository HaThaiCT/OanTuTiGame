#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[ "$(id -u)" = 0 ] || exit 1
dst=/usr/local/libexec/oantuti/trusted-match-v1
src=/home/ha-thai/.local/share/oantuti/development/trusted-match-reaper-update
stage=$(mktemp -d /var/tmp/oantuti-match-reaper.XXXXXXXX)
# Authenticate the previous version before changing exactly this installed bundle.
(cd "$dst" && sha256sum --check <<'OLD'
413cc8655aaac2e2e3617d39f81825a0974ea0a20255428f2d74bbdbf60c55de  trusted-match.py
67adc5a0c7ffcc1b04be37cc149373308deaa12062227e90b97be9de2a2da0be  supervisor
72759489ca5b38ddefa14854f5c6d17296cfbb79f82b5496100df1647cf4acb7  manifest.json
OLD
)
[ ! -e "$dst/reaper" ] && [ ! -L "$dst/reaper" ]
for name in trusted-match.py supervisor reaper manifest.json; do
 install -o root -g root -m 0600 "$src/$name" "$stage/$name"
done
(cd "$stage" && sha256sum --check <<'NEW'
8caf055707acf8cee074fc3346b7dd35f8a4fd1e2172fcd551f3027c80fbf8b7  trusted-match.py
78518efcbfe58741dab39e9e37e5ce0634226099d8aa4f19171e087c8f6ea89b  supervisor
874dbbc7e8e2bfdcfd18bf253dd768a0062af9d400bc640f9c83724d709bd88b  reaper
a9bb98b1813a3b6a96c1ed5d1efeb410397a303eddccdfdb83b5e3333f0d13f8  manifest.json
NEW
)
# Refuse symlink/writable ancestors. Save old files for operator rollback.
/usr/bin/python3 -I -c 'import pathlib,stat
p=pathlib.Path("/usr/local/libexec/oantuti/trusted-match-v1")
for q in [p,*p.parents]:
 s=q.lstat()
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or s.st_mode&0o6022: raise SystemExit("Unsafe target")'
for name in trusted-match.py supervisor manifest.json; do cp -- "$dst/$name" "$stage/old-$name"; done
# No sudoers change. Avoid concurrent match invocation during this operator update.
for name in supervisor reaper; do install -o root -g root -m 0755 "$stage/$name" "$dst/$name"; done
install -o root -g root -m 0644 "$stage/manifest.json" "$dst/manifest.json"
install -o root -g root -m 0755 "$stage/trusted-match.py" "$dst/trusted-match.py"
echo TRUSTED_MATCH_REAPER_UPDATED
printf 'Rollback copies: %s\n' "$stage"
