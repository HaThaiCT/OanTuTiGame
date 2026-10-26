#!/usr/bin/env bash
# Isolated QA commissioning only. Independent review is required before execution.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
repo=$(realpath -- "$(dirname -- "$0")/../..")
for name in arena-job-broker arena-worker arena-reaper; do
 [[ -f $repo/target/release/$name && ! -L $repo/target/release/$name ]] || { echo "Missing native release input: $repo/target/release/$name; run bash $repo/deploy/linux/prepare-native-worker.sh as your normal user before sudo installation." >&2; exit 1; }
done
(cd "$repo/target/release" && sha256sum --check <<'NATIVE_HASHES'
4e22abba40b1df9bf65a974e2dc34d82e021e8c6f89c5a88c4fe35edd23f0ac8  arena-job-broker
62b9ee89ce4ba65f0def849442dabfc67c06e769607ec9b919c3e0083d965977  arena-worker
942d2ff976cfd26c76ad167bede5878de0158c3ec7d924f51d798f1ae0de3384  arena-reaper
NATIVE_HASHES
) || { echo 'Native release input checksum mismatch; do not install or repin without independent review.' >&2; exit 1; }
if [[ ${1-} = --check-inputs && $# = 1 ]]; then exit 0; fi
[[ $# = 0 ]] || { echo 'Usage: operator-commission-worker.sh [--check-inputs]' >&2; exit 1; }
[[ $EUID = 0 ]] || { echo 'Root authorization required; no changes made.' >&2; exit 1; }
prefix=/usr/local/libexec/oantuti/qa-native-20261026
state=/var/lib/oantuti-qa-native
config=/etc/oantuti-qa-native
unit=/etc/systemd/system/oantuti-qa-native.service
policy=/etc/apparmor.d/oantuti-qa-native-runsc
rootfs=/var/lib/oantuti/development/rootfs/fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb
archive=/usr/local/libexec/oantuti/three-language-v1/rootfs.tar
toolchain_rootfs=/var/lib/oantuti/development/toolchains/626e4e3c7f82a95dfec96954b6909543ef38159833b0ae9a061ce71100de0730
toolchain_archive=/home/ha-thai/.local/share/oantuti/development/native-rootfs-entrypoints-20261026.tar
[[ $(id -u ha-thai) = 1000 && $(id -g ha-thai) = 1000 && $(id -u arena-supervisor) = 997 && $(id -g arena-supervisor) = 984 ]] || { echo 'Measured identities changed' >&2; exit 1; }
systemd_version=$(systemd --version)
systemd_version=${systemd_version#systemd }
systemd_version=${systemd_version%% *}
[[ $systemd_version =~ ^[0-9]+$ && $systemd_version -ge 254 ]] || { echo 'DelegateSubgroup requires systemd >=254' >&2; exit 1; }
# Refuse unsafe ancestors and all prior targets; never repair an unrelated tree.
python3 -I - "$prefix" "$state" "$config" "$unit" "$policy" /run/oantuti-qa-native <<'PY'
import os, pathlib, stat, sys
for value in sys.argv[1:]:
 p=pathlib.Path(value)
 if os.path.lexists(p): raise SystemExit('Refusing existing target: '+value)
 for a in p.parents:
  if not os.path.lexists(a): continue
  s=a.lstat()
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:
   raise SystemExit('Unsafe ancestor: '+str(a))
PY
stage=$(mktemp -d /var/tmp/oantuti-qa-native.XXXXXXXX)
chmod 0700 "$stage"
created_paths=()
bundle=''
apparmor_installed=no
track_new() {
 local path=$1 identity kind=file
 [[ -d $path && ! -L $path ]] && kind=dir
 identity=$(stat -c '%d:%i' -- "$path")
 created_paths+=("$path|$identity|$kind")
}
rollback() {
 local status=$? entry path rest identity kind current index
 if (( status != 0 )); then
  set +e
  [[ $apparmor_installed != yes ]] || apparmor_parser -R "$policy"
  for ((index=${#created_paths[@]}-1; index>=0; index--)); do
   entry=${created_paths[index]}; path=${entry%%|*}; rest=${entry#*|}; identity=${rest%%|*}; kind=${rest##*|}
   current=$(stat -c '%d:%i' -- "$path" 2>/dev/null)
   [[ $current != "$identity" ]] && continue
   if [[ $kind = dir ]]; then rmdir -- "$path" 2>/dev/null || true; else rm -f -- "$path"; fi
  done
  [[ -z $bundle ]] || rm -rf -- "$bundle"
  systemctl daemon-reload >/dev/null 2>&1 || true
 fi
 rm -rf -- "$stage"
 return "$status"
}
trap rollback EXIT
# Snapshot regular files into a root-private tree; checks below hash ONLY snapshots.
python3 -I - "$repo" "$stage" "$toolchain_archive" <<'PY'
import os, stat, sys
repo,stage,toolchain_archive=sys.argv[1:]
sources={name:repo+'/target/release/'+name for name in ('arena-worker','arena-reaper','arena-job-broker')}
sources.update({'runsc':'/usr/local/libexec/oantuti/gvisor-20261005.0/runsc','runtime-profile.json':repo+'/deploy/linux/runtime-profile.json','verify-rootfs.py':repo+'/deploy/linux/verify-rootfs.py','promote-toolchain-rootfs.py':repo+'/deploy/linux/promote-toolchain-rootfs.py','toolchain-rootfs.tar':toolchain_archive})
for name,source in sources.items():
 fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd)
  limit=700*1024*1024 if name=='toolchain-rootfs.tar' else 128*1024*1024
  if not stat.S_ISREG(s.st_mode) or s.st_size>limit: raise SystemExit('Unsafe source: '+source)
  out=os.open(stage+'/'+name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  try:
   with os.fdopen(out,'wb') as target:
    while chunk:=os.read(fd,1024*1024): target.write(chunk)
    target.flush(); os.fsync(target.fileno())
  finally: pass
 finally: os.close(fd)
PY
(cd "$stage" && sha256sum --check <<'HASHES'
4e22abba40b1df9bf65a974e2dc34d82e021e8c6f89c5a88c4fe35edd23f0ac8  arena-job-broker
62b9ee89ce4ba65f0def849442dabfc67c06e769607ec9b919c3e0083d965977  arena-worker
942d2ff976cfd26c76ad167bede5878de0158c3ec7d924f51d798f1ae0de3384  arena-reaper
210b437a9cfae51e8f8c9074ed19b8b5e59477178e2e391a18117d8d6b924f7a  runsc
719b93dc11c56b1ab7f1bffee1b20b58107a981e59d9c061408c5d329cf931e7  runtime-profile.json
241f0df337d7fe59d3bc8d8bcfd47e31705d2d877ef14c51b21d7a89baf233c7  verify-rootfs.py
a0680677b3dee99add63ca9ddb035f7adb72a2aa48462544b521f19387b7fde4  promote-toolchain-rootfs.py
626e4e3c7f82a95dfec96954b6909543ef38159833b0ae9a061ce71100de0730  toolchain-rootfs.tar
HASHES
)
toolchain_stage="$stage/toolchain-rootfs"
python3 -I - "$stage" "$toolchain_stage" <<'PY'
import importlib.util,sys
base,root=sys.argv[1:]
spec=importlib.util.spec_from_file_location('promoter',base+'/promote-toolchain-rootfs.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.prepare(base+'/toolchain-rootfs.tar',root,verifier_path=base+'/verify-rootfs.py')
PY
python3 -I "$stage/verify-rootfs.py" --archive "$archive" --rootfs "$rootfs" --archive-sha256 fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb
[[ $(chroot "$toolchain_stage" /usr/bin/python3 --version) = 'Python 3.12.3' ]]
[[ $(chroot "$toolchain_stage" /usr/bin/node --version) = 'v24.22.0' ]]
cpp=$(chroot "$toolchain_stage" /usr/bin/g++ --version)
[[ $cpp = *13.3.0* ]]
chroot "$toolchain_stage" /usr/bin/g++ -std=c++20 -x c++ -fsyntax-only - <<'CPP'
#include <iostream>
#include <vector>
int main() { std::vector<int> values{42}; std::cout << values[0]; }
CPP
cat > "$stage/toolchains.json" <<EOF
{"PYTHON":{"rootfs":"$toolchain_rootfs","imageDigest":"626e4e3c7f82a95dfec96954b6909543ef38159833b0ae9a061ce71100de0730","version":"3.12.3","flags":["-m","py_compile"]},"TYPESCRIPT":{"rootfs":"$toolchain_rootfs","imageDigest":"626e4e3c7f82a95dfec96954b6909543ef38159833b0ae9a061ce71100de0730","version":"24.22.0","flags":[]},"CPP":{"rootfs":"$toolchain_rootfs","imageDigest":"626e4e3c7f82a95dfec96954b6909543ef38159833b0ae9a061ce71100de0730","version":"13.3.0","flags":["-std=c++20"]}}
EOF
python3 -I - "$stage" "$prefix" "$state" <<'PY'
import json,sys
stage,prefix,state=sys.argv[1:]
tools=json.load(open(stage+'/toolchains.json'))
config={'executable':prefix+'/arena-job-broker','socketPath':'/run/oantuti-qa-native/broker.sock','workerUid':997,'socketGid':984,'grantGid':984,'deploymentGeneration':20261026,'runtimeProfileDigest':'719b93dc11c56b1ab7f1bffee1b20b58107a981e59d9c061408c5d329cf931e7','maxBuildSlots':1,'maxGameSlots':1,'spoolRoot':state+'/grants','compiledArtifactsDir':state+'/api-artifacts','toolchains':[{'language':k,**{a:b for a,b in v.items() if a!='rootfs'}} for k,v in tools.items()]}
with open(stage+'/native-gateway.json','w') as out: json.dump(config,out,indent=2)
PY
cat > "$stage/launch-worker" <<'SH'
#!/bin/sh
set -eu
# systemd places this process in DelegateSubgroup=anchor, leaving parent empty.
IFS= read -r entry < /proc/self/cgroup
case "$entry" in 0::/*/anchor) relative=${entry#0::}; root=/sys/fs/cgroup${relative%/anchor};; *) echo 'Expected unified delegated anchor' >&2; exit 1;; esac
exec /usr/local/libexec/oantuti/qa-native-20261026/arena-worker --broker-socket /run/oantuti-qa-native/broker.sock --runsc /usr/local/libexec/oantuti/qa-native-20261026/runsc --runtime-rootfs /var/lib/oantuti/development/rootfs/fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb --cgroup-root "$root" --attempt-root /var/lib/oantuti-qa-native/worker-attempts --runtime-profile-digest 719b93dc11c56b1ab7f1bffee1b20b58107a981e59d9c061408c5d329cf931e7 --max-game-slots 1 --max-build-slots 1 --toolchains /etc/oantuti-qa-native/toolchains.json --artifact-output-root /var/lib/oantuti-qa-native/worker-output
SH
cat > "$stage/launch-api" <<'SH'
#!/bin/sh
set -eu
test "$(id -u)" = 0
cd /home/ha-thai/orca/workspaces/OanTuTi/develop-online-v2-2
exec /usr/sbin/runuser --user ha-thai --group ha-thai --supp-group arena-supervisor -- /usr/bin/env -i HOME=/home/ha-thai USER=ha-thai LOGNAME=ha-thai PATH=/usr/local/bin:/usr/bin:/bin OANTUTI_NATIVE_CONFIG=/etc/oantuti-qa-native/native-gateway.json /home/ha-thai/.local/bin/node /tmp/oantuti-isolated-20261026/start-api.mjs
SH
cat > "$stage/oantuti-qa-native.service" <<'UNIT'
[Unit]
Description=OanTuTi isolated QA native commissioning worker
[Service]
Type=simple
User=arena-supervisor
Group=arena-supervisor
ExecStart=/usr/local/libexec/oantuti/qa-native-20261026/launch-worker
Delegate=cpu memory pids
DelegateSubgroup=anchor
NoNewPrivileges=true
TemporaryFileSystem=/var/lib/oantuti-qa-native/worker-output:rw,nosuid,nodev,size=536870912,mode=0700,uid=997,gid=984
KillMode=mixed
TimeoutStopSec=20
Restart=no
LimitNOFILE=65536
UNIT
cat > "$stage/oantuti-qa-native-runsc" <<'POLICY'
abi <abi/4.0>,
include <tunables/global>
profile oantuti-qa-native-runsc /usr/local/libexec/oantuti/qa-native-20261026/runsc flags=(unconfined) {
  userns,
}
POLICY
apparmor_parser --skip-kernel-load --skip-read-cache "$stage/oantuti-qa-native-runsc"
systemd-analyze verify "$stage/oantuti-qa-native.service"
# Publish new immutable bundle atomically on the destination filesystem.
bundle=$(mktemp -d /usr/local/libexec/oantuti/.qa-native.XXXXXXXX)
chmod 0755 "$bundle"
for name in arena-job-broker arena-worker arena-reaper runsc launch-worker launch-api; do install -o root -g root -m 0755 "$stage/$name" "$bundle/$name"; done
install -o root -g root -m 0644 "$stage/runtime-profile.json" "$bundle/runtime-profile.json"
mv -T -- "$bundle" "$prefix"
track_new "$prefix"
for name in arena-job-broker arena-worker arena-reaper runsc launch-worker launch-api runtime-profile.json; do track_new "$prefix/$name"; done
bundle=''
install -d -o root -g arena-supervisor -m 0750 "$state"; track_new "$state"
install -d -o root -g arena-supervisor -m 0750 "$config"; track_new "$config"
install -d -o ha-thai -g arena-supervisor -m 0750 /run/oantuti-qa-native; track_new /run/oantuti-qa-native
install -d -o ha-thai -g arena-supervisor -m 0710 "$state/grants"; track_new "$state/grants"
install -d -o ha-thai -g ha-thai -m 0700 "$state/api-artifacts"; track_new "$state/api-artifacts"
install -d -o arena-supervisor -g arena-supervisor -m 0700 "$state/worker-attempts"; track_new "$state/worker-attempts"
install -d -o arena-supervisor -g arena-supervisor -m 0700 "$state/worker-output"; track_new "$state/worker-output"
for name in toolchains.json native-gateway.json; do install -o root -g arena-supervisor -m 0640 "$stage/$name" "$config/$name"; track_new "$config/$name"; done
install -o root -g root -m 0644 "$stage/oantuti-qa-native.service" "$unit"; track_new "$unit"
install -o root -g root -m 0644 "$stage/oantuti-qa-native-runsc" "$policy"; track_new "$policy"
apparmor_parser --replace "$policy"
apparmor_installed=yes
systemd-analyze verify "$unit"
systemctl daemon-reload
toolchain_result=$(python3 -I - "$stage" <<'PY'
import importlib.util,sys
base=sys.argv[1]
spec=importlib.util.spec_from_file_location('promoter',base+'/promote-toolchain-rootfs.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
result,created,parent_created,target_device,target_inode,parent_device,parent_inode=module.publish_from(base+'/toolchain-rootfs.tar',base+'/toolchain-rootfs')
print(('CREATED' if created else 'REUSED')+' '+str(target_device)+' '+str(target_inode)+' '+str(parent_device)+' '+str(parent_inode))
PY
)
read -r toolchain_status toolchain_device toolchain_inode parent_device parent_inode <<< "$toolchain_result"
printf '%s\n' 'INSTALLED; NOT STARTED. Only isolated API may receive native-gateway.json with supplementary group984. No readiness claim.'
