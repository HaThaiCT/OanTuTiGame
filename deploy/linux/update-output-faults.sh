#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[ "$(id -u)" = 0 ] || exit 1
stage=$(mktemp -d /var/tmp/oantuti-fault-update.XXXXXXXX)
src=/home/ha-thai/.local/share/oantuti/development/output-fault-update
install -o root -g root -m 0600 "$src/three.json" "$stage/three.json"
install -o root -g root -m 0600 "$src/python.json" "$stage/python.json"
install -o root -g root -m 0600 "$src/supervisor" "$stage/supervisor"
(cd "$stage" && sha256sum --check <<'HASHES'
a16bfbe96c3151f931a0d3116a5482d5e1520e17db1f4edfb85c028fd704a4f2  three.json
9b9aa8106daac251c1d0646a3c66a86cd099347937cc38eb793353a26b705742  python.json
a2d7060660be4ec3e1328f81f9a47140bc0a15df5062611b08a763f826c5f779  supervisor
HASHES
)
printf '%s  %s\n' a9bb98b1813a3b6a96c1ed5d1efeb410397a303eddccdfdb83b5e3333f0d13f8 /usr/local/libexec/oantuti/trusted-match-v1/manifest.json | sha256sum --check -
printf '%s  %s\n' 78518efcbfe58741dab39e9e37e5ce0634226099d8aa4f19171e087c8f6ea89b /usr/local/libexec/oantuti/trusted-match-v1/supervisor | sha256sum --check -
printf '%s  %s\n' 9f04ba4f23755053b648162ce89adcb2174bbfb75fc898f2d19010c4b56156f6 /usr/local/libexec/oantuti/three-language-v1/manifest.json | sha256sum --check -
printf '%s  %s\n' 78518efcbfe58741dab39e9e37e5ce0634226099d8aa4f19171e087c8f6ea89b /usr/local/libexec/oantuti/three-language-v1/supervisor | sha256sum --check -
/usr/bin/python3 -I -c 'import pathlib,stat
for name in ("trusted-match-v1", "three-language-v1"):
 p=pathlib.Path("/usr/local/libexec/oantuti")/name
 for q in [p,*p.parents]:
  s=q.lstat()
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or s.st_mode&0o6022: raise SystemExit("Unsafe target")'
cp -- /usr/local/libexec/oantuti/trusted-match-v1/supervisor "$stage/old-python-supervisor"
cp -- /usr/local/libexec/oantuti/trusted-match-v1/manifest.json "$stage/old-python-manifest.json"
install -o root -g root -m 0755 "$stage/supervisor" /usr/local/libexec/oantuti/trusted-match-v1/supervisor
install -o root -g root -m 0644 "$stage/python.json" /usr/local/libexec/oantuti/trusted-match-v1/manifest.json
cp -- /usr/local/libexec/oantuti/three-language-v1/supervisor "$stage/old-three-supervisor"
cp -- /usr/local/libexec/oantuti/three-language-v1/manifest.json "$stage/old-three-manifest.json"
install -o root -g root -m 0755 "$stage/supervisor" /usr/local/libexec/oantuti/three-language-v1/supervisor
install -o root -g root -m 0644 "$stage/three.json" /usr/local/libexec/oantuti/three-language-v1/manifest.json
echo OUTPUT_FAULT_UPDATE_INSTALLED
printf 'Rollback copies: %s\n' "$stage"
