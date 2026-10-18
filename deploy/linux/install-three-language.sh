#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[ "$(id -u)" = 0 ] || exit 1
src=/home/ha-thai/.local/share/oantuti/development/three-language-payload-v1
dst=/usr/local/libexec/oantuti/three-language-v1
policy=/etc/sudoers.d/oantuti-three-language-v1
rootfs=/var/lib/oantuti/development/rootfs/fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb
for p in "$dst" "$policy" "$rootfs"; do
 if [ -e "$p" ] || [ -L "$p" ]; then echo "Target exists; refusing overwrite: $p" >&2; exit 1; fi
done
stage=$(mktemp -d /var/tmp/oantuti-three-language.XXXXXXXX)
install -o root -g root -m 0600 "$src/config-cpp.json" "$stage/config-cpp.json"
install -o root -g root -m 0600 "$src/config-python.json" "$stage/config-python.json"
install -o root -g root -m 0600 "$src/config-typescript.json" "$stage/config-typescript.json"
install -o root -g root -m 0600 "$src/manifest.json" "$stage/manifest.json"
install -o root -g root -m 0600 "$src/promote-compiled-rootfs.py" "$stage/promote-compiled-rootfs.py"
install -o root -g root -m 0600 "$src/reaper" "$stage/reaper"
install -o root -g root -m 0600 "$src/start.pb" "$stage/start.pb"
install -o root -g root -m 0600 "$src/sudoers" "$stage/sudoers"
install -o root -g root -m 0600 "$src/supervisor" "$stage/supervisor"
install -o root -g root -m 0600 "$src/three-language-match.py" "$stage/three-language-match.py"
install -o root -g root -m 0600 "$src/trusted-match.py" "$stage/trusted-match.py"
install -o root -g root -m 0600 "$src/verify-rootfs.py" "$stage/verify-rootfs.py"
(cd "$stage" && sha256sum --check <<'HASHES'
b4b66d2558e6d5846dc3e9c5b979ec44c239ce6253cf5a8090b33ce29e53888b  config-cpp.json
8e65fcd0f6ad0b78ef35125f01086aec61f8d583805029aaedf40de53ec52258  config-python.json
8399ff93efa5302957163165ddd53c1de96d28a61ccd6b6991e7040dd185de75  config-typescript.json
9f04ba4f23755053b648162ce89adcb2174bbfb75fc898f2d19010c4b56156f6  manifest.json
6efe1fa84d31cbbfe9b3742e8937137285484325b0d42ee7ba051eaaf27d3da2  promote-compiled-rootfs.py
874dbbc7e8e2bfdcfd18bf253dd768a0062af9d400bc640f9c83724d709bd88b  reaper
bfc23d5ef5e175f030aaf00d8ebd45f863097f60941582ba359ee8b2576b49e8  start.pb
88ebef44ebde1e6460e2f4ec4b6ea49048f4e982da3b7ec765feab11d52b410e  sudoers
78518efcbfe58741dab39e9e37e5ce0634226099d8aa4f19171e087c8f6ea89b  supervisor
968a09285b53a0b26198e9ae8433c9e7458dfec17f68971aaf5bd9375dc174fb  three-language-match.py
30d23cb0f71ab07934e451c55a295fe076e8b48f2d3f4a289b6701959d2346c4  trusted-match.py
8b8736ae7040c8f3d232e1024dbedbbaa66e93c35b7b593e7334295e270c1a6c  verify-rootfs.py
HASHES
)
install -o root -g root -m 0600 /home/ha-thai/.local/share/oantuti/development/compiled-starters-rootfs.tar "$stage/rootfs.tar"
printf '%s  %s
' fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb "$stage/rootfs.tar" | sha256sum --check -
/usr/bin/python3 -I -c 'import pathlib,stat
for value in ("/usr/local/libexec/oantuti", "/var/lib/oantuti/development/rootfs", "/etc/sudoers.d"):
 p=pathlib.Path(value)
 for q in [p,*p.parents]:
  s=q.lstat()
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or s.st_mode&0o6022: raise SystemExit("Unsafe ancestor")'
visudo -c
visudo -cf "$stage/sudoers"
/usr/bin/python3 -I "$stage/promote-compiled-rootfs.py"
install -d -o root -g root -m 0755 "$dst"
for name in trusted-match.py three-language-match.py supervisor reaper; do install -o root -g root -m 0755 "$stage/$name" "$dst/$name"; done
for name in config-python.json config-typescript.json config-cpp.json start.pb manifest.json verify-rootfs.py; do install -o root -g root -m 0644 "$stage/$name" "$dst/$name"; done
install -o root -g root -m 0600 "$stage/rootfs.tar" "$dst/rootfs.tar"
install -o root -g root -m 0440 "$stage/sudoers" "$policy"
if ! visudo -c; then rm -- "$policy"; exit 1; fi
echo THREE_LANGUAGE_MATCH_INSTALLED
