#!/usr/bin/python3 -I
"""Root-only, fixed sleep0 gVisor probe. Requires reviewed root-owned installation."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import uuid

RUNSC = Path('/usr/local/libexec/oantuti/gvisor-20261005.0/runsc')
TREE = '7a86c93baf6ff2407ebdbfa85715f3542b6b5c1a07a481dd4c3f1cfb14392d78'
RUNSC_HASH = '210b437a9cfae51e8f8c9074ed19b8b5e59477178e2e391a18117d8d6b924f7a'
SPEC_HASH = '7a9a6f0caa5fa43888947d1e024f21e2e84bc690685f6c7529c15874041312b0'
COMPANIONS = {
    'checkpointgofer': 'c454d0b5fab4627d8915194f901a70c66bb4792f680e3f75d2a47516382b449a',
    'gvisor-sentry-prewarmer': '3315d7ad7c2d3751d349e4976fa02da1da6fd7e41746c35622304e5fabe4fce0',
    'gvisor_sentry': '0050e7c6063e17de1729500cd73b18322d85c758eb0ffcab18e539df7110bd12',
    'runsc-fd-parking': '03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11',
    'runsc-metric-server': '7bcbe5846a0f6d34c7d2bd312033bb92ab6305b9ac93e09b753b3474f91f27b2',
}
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/root'}


def trusted(path):
    for entry in [path, *path.parents]:
        info = entry.lstat()
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o6022:
            raise RuntimeError('untrusted privileged path')
    if not path.is_file():
        raise RuntimeError('not a regular privileged file')

def verify_file(path, expected):
    trusted(path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError('privileged input integrity mismatch')



def runsc_command(state, container, bundle=None):
    command = [str(RUNSC), '--root=' + str(state), '--network=none', '--overlay2=none',
               '--platform=systrap', '--gofer-network-namespace=new', '--host-settings=check', '--host-uds=none',
               '--host-fifo=none', '--sidecar-usage-policy=STRICT',
               '--sidecar-release-enforcement-policy=ALWAYS']
    return command + (['run', '--bundle=' + str(bundle), container] if bundle else ['delete', '--force', container])

def stop_and_confirm(unit):
    group = Path('/sys/fs/cgroup/system.slice') / unit
    result = subprocess.run(['systemctl', 'stop', unit], env=ENV, cwd='/',
                            capture_output=True, timeout=10)
    # A successful transient unit can already be unloaded. Only kernel absence
    # confirms this case; do not reinterpret other stop failures as success.
    if result.returncode != 0 and group.exists():
        raise RuntimeError('service stop failed with cgroup still present')
    if group.exists():
        fields = dict(line.split() for line in (group / 'cgroup.events').read_text().splitlines())
        if fields.get('populated') != '0':
            raise RuntimeError('service descendants remain')
    if (group / 'sandbox').exists():
        raise RuntimeError('sandbox cgroup removal not confirmed')



def main():
    import sys
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise SystemExit('REJECTED: root required; no arguments allowed')
    trusted(Path(__file__).absolute())
    verify_file(RUNSC, RUNSC_HASH)
    for name, expected in COMPANIONS.items():
        verify_file(RUNSC.parent / 'gvisor-bin' / name, expected)
    receipt = subprocess.run(['/usr/local/sbin/oantuti-dev-helper-v1', 'verify-rootfs'],
                             env=ENV, cwd='/', stdin=subprocess.DEVNULL,
                             capture_output=True, text=True, timeout=60, check=True)
    if json.loads(receipt.stdout).get('normalizedTreeSha256') != TREE:
        raise RuntimeError('rootfs identity mismatch')
    spec_source = Path(__file__).absolute().with_name('trusted-oci-spec.py')
    verify_file(spec_source, SPEC_HASH)
    spec = json.loads(subprocess.check_output(['/usr/bin/python3', '-I', str(spec_source)], env=ENV, cwd='/', timeout=5))
    unit = 'oantuti-gvisor-smoke-' + uuid.uuid4().hex + '.service'
    container = 'trusted-' + uuid.uuid4().hex
    # Service parent remains systemd-owned; runsc owns only this fixed child.
    spec['linux']['cgroupsPath'] = '/system.slice/' + unit + '/sandbox'
    parent = Path('/var/lib/oantuti/development')
    for entry in [parent, *parent.parents]:
        info = entry.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o6022:
            raise RuntimeError('unsafe runtime state parent')
    with tempfile.TemporaryDirectory(prefix='gvisor-smoke-', dir=parent) as temporary:
        work = Path(temporary)
        bundle = work / 'bundle'
        bundle.mkdir(mode=0o700)
        (bundle / 'config.json').write_text(json.dumps(spec))
        state = work / 'state'
        state.mkdir(mode=0o700)
        command = ['systemd-run', '--quiet', '--wait', '--pipe', '--unit=' + unit,
                   '--property=Delegate=yes', '--property=DelegateSubgroup=launcher', '--property=MemoryMax=512M',
                   '--property=MemorySwapMax=0', '--property=TasksMax=128',
                   '--property=CPUQuota=100%', '--property=RuntimeMaxSec=15',
                   '--property=KillMode=control-group', '--property=UMask=0077',
                   '--property=NoNewPrivileges=yes'] + runsc_command(state, container, bundle)
        try:
            result = subprocess.run(command, env=ENV, cwd='/', stdin=subprocess.DEVNULL,
                                    capture_output=True, timeout=20)
            if result.returncode != 0:
                raise RuntimeError('trusted gVisor launch failed; inspect operator journal for unit ' + unit)
        finally:
            # Always attempt runtime cleanup, even if stopping the unit fails.
            try:
                stop_and_confirm(unit)
            finally:
                listing = subprocess.run([str(RUNSC), '--root=' + str(state), 'list', '--format=json'],
                                         env=ENV, cwd='/', capture_output=True, text=True, timeout=10, check=True)
                entries = json.loads(listing.stdout)
                if entries:
                    subprocess.run(runsc_command(state, container), env=ENV, cwd='/',
                                   stdin=subprocess.DEVNULL, capture_output=True, timeout=10, check=True)
                final = subprocess.run([str(RUNSC), '--root=' + str(state), 'list', '--format=json'],
                                       env=ENV, cwd='/', capture_output=True, text=True, timeout=10, check=True)
                if json.loads(final.stdout):
                    raise RuntimeError('runtime state cleanup not confirmed')
            stop_and_confirm(unit)
            subprocess.run(['systemctl', 'reset-failed', unit], env=ENV, cwd='/', capture_output=True, timeout=5)
    # TemporaryDirectory cleanup must also finish before reporting success.
    print(json.dumps({'status': 'PASS', 'unit': unit, 'kernel': os.uname().release,
                      'workload': '/usr/bin/sleep 0', 'runscRelease': '20261005.0',
                      'rootfsTreeSha256': TREE, 'runtimeStateEmpty': True,
                      'botExecuted': False, 'gvisorCertified': False}))


if __name__ == '__main__':
    main()
