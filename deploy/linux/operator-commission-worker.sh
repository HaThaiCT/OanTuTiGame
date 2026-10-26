#!/usr/bin/env bash
# Isolated QA commissioning only. Independent review is required before execution.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID = 0 ]] || { echo 'Root authorization required; no changes made.' >&2; exit 1; }
repo=$(realpath -- "$(dirname -- "$0")/../..")
prefix=/usr/local/libexec/oantuti/qa-native-20261026
state=/var/lib/oantuti-qa-native
config=/etc/oantuti-qa-native
unit=/etc/systemd/system/oantuti-qa-native.service
policy=/etc/apparmor.d/oantuti-qa-native-runsc
rootfs=/var/lib/oantuti/development/rootfs/fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb
archive=/usr/local/libexec/oantuti/three-language-v1/rootfs.tar
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
trap 'rm -rf -- "$stage"' EXIT
# Snapshot regular files into a root-private tree; checks below hash ONLY snapshots.
python3 -I - "$repo" "$stage" <<'PY'
import os, stat, sys
repo,stage=sys.argv[1:]
sources={name:'/tmp/oantuti-native-bin/'+name for name in ('arena-worker','arena-reaper','arena-job-broker')}
sources.update({'runsc':'/usr/local/libexec/oantuti/gvisor-20261005.0/runsc','runtime-profile.json':repo+'/deploy/linux/runtime-profile.json','verify-rootfs.py':repo+'/deploy/linux/verify-rootfs.py'})
for name,source in sources.items():
 fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode) or s.st_size>128*1024*1024: raise SystemExit('Unsafe source: '+source)
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
8b8736ae7040c8f3d232e1024dbedbbaa66e93c35b7b593e7334295e270c1a6c  verify-rootfs.py
HASHES
)
python3 -I "$stage/verify-rootfs.py" --archive "$archive" --rootfs "$rootfs" --archive-sha256 fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb
# Read-only measurements: execute only installed operator-owned rootfs binaries.
[[ $(chroot "$rootfs" /usr/bin/python3 --version) = 'Python 3.12.3' ]]
[[ $(chroot "$rootfs" /usr/bin/node --version) = 'v24.22.0' ]]
cpp=$(chroot "$rootfs" /usr/bin/g++ --version)
[[ $cpp = *13.3.0* ]]
cat > "$stage/toolchains.json" <<EOF
{"PYTHON":{"rootfs":"$rootfs","imageDigest":"fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb","version":"3.12.3","flags":["-m","py_compile"]},"TYPESCRIPT":{"rootfs":"$rootfs","imageDigest":"fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb","version":"24.22.0","flags":[]},"CPP":{"rootfs":"$rootfs","imageDigest":"fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb","version":"13.3.0","flags":["-std=c++20"]}}
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
# Publish new immutable bundle atomically on the destination filesystem.
bundle=$(mktemp -d /usr/local/libexec/oantuti/.qa-native.XXXXXXXX)
chmod 0755 "$bundle"
for name in arena-job-broker arena-worker arena-reaper runsc launch-worker launch-api; do install -o root -g root -m 0755 "$stage/$name" "$bundle/$name"; done
install -o root -g root -m 0644 "$stage/runtime-profile.json" "$bundle/runtime-profile.json"
mv -T -- "$bundle" "$prefix"
install -d -o root -g arena-supervisor -m 0750 "$state" "$config"
install -d -o ha-thai -g arena-supervisor -m 0750 /run/oantuti-qa-native
install -d -o ha-thai -g arena-supervisor -m 0710 "$state/grants"
install -d -o ha-thai -g ha-thai -m 0700 "$state/api-artifacts"
install -d -o arena-supervisor -g arena-supervisor -m 0700 "$state/worker-attempts" "$state/worker-output"
for name in toolchains.json native-gateway.json; do install -o root -g arena-supervisor -m 0640 "$stage/$name" "$config/$name"; done
install -o root -g root -m 0644 "$stage/oantuti-qa-native.service" "$unit"
install -o root -g root -m 0644 "$stage/oantuti-qa-native-runsc" "$policy"
systemd-analyze verify "$unit"
apparmor_parser --replace "$policy"
systemctl daemon-reload
printf '%s\n' 'INSTALLED; NOT STARTED. Only isolated API may receive native-gateway.json with supplementary group984. No readiness claim.'
