#!/usr/bin/python3 -I
"""Fixed developer starter-Bot match. No caller arguments or uploaded sources."""
import copy
import hashlib
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import tempfile
import uuid

ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/root'}
ROOTFS = '/var/lib/oantuti/development/rootfs/63768f52c0ba59396b40aabfa6ced7650d5f7b309ba09d9e606b7189eb3865b4'
TREE = '7a86c93baf6ff2407ebdbfa85715f3542b6b5c1a07a481dd4c3f1cfb14392d78'
RUNTIME_HASHES = {
    'runsc': '210b437a9cfae51e8f8c9074ed19b8b5e59477178e2e391a18117d8d6b924f7a',
    'gvisor-bin/checkpointgofer': 'c454d0b5fab4627d8915194f901a70c66bb4792f680e3f75d2a47516382b449a',
    'gvisor-bin/gvisor-sentry-prewarmer': '3315d7ad7c2d3751d349e4976fa02da1da6fd7e41746c35622304e5fabe4fce0',
    'gvisor-bin/gvisor_sentry': '0050e7c6063e17de1729500cd73b18322d85c758eb0ffcab18e539df7110bd12',
    'gvisor-bin/runsc-fd-parking': '03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11',
    'gvisor-bin/runsc-metric-server': '7bcbe5846a0f6d34c7d2bd312033bb92ab6305b9ac93e09b753b3474f91f27b2',
}


def checked(*args):
    return subprocess.check_output(args, env=ENV, cwd='/', text=True, timeout=30).strip()


def run_match(config_name='config.json', rootfs=ROOTFS, tree=TREE, archive=None):
    installed = Path(__file__).absolute().parent
    # These payloads must be copied/hash-verified by the operator installer.
    for path in [installed / 'trusted-match.py', installed / 'manifest.json', installed / 'supervisor', installed / 'reaper', installed / 'start.pb', installed / config_name]:
        for entry in [path, *path.parents]:
            st = entry.lstat()
            if st.st_uid != 0 or st.st_gid != 0 or entry.is_symlink() or st.st_mode & 0o6022:
                raise RuntimeError('untrusted installed match payload')
    manifest = json.loads((installed / 'manifest.json').read_text())
    if not {'supervisor', 'reaper', 'start.pb', config_name}.issubset(manifest) or any('/' in name or name.startswith('.') for name in manifest):
        raise RuntimeError('invalid trusted match installation manifest')
    for name, digest in manifest.items():
        if hashlib.sha256((installed / name).read_bytes()).hexdigest() != digest:
            raise RuntimeError('installed match payload changed')
    for name, digest in RUNTIME_HASHES.items():
        path = Path('/usr/local/libexec/oantuti/gvisor-20261005.0') / name
        for entry in [path, *path.parents]:
            info = entry.lstat()
            if info.st_uid != 0 or info.st_gid != 0 or entry.is_symlink() or info.st_mode & 0o6022:
                raise RuntimeError('untrusted runtime path')
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError('runtime integrity mismatch')
    if archive is None:
        receipt = json.loads(checked('/usr/local/sbin/oantuti-dev-helper-v1', 'verify-rootfs'))
    else:
        receipt = json.loads(checked('/usr/bin/python3', '-I', str(installed / 'verify-rootfs.py'),
                                    '--archive', str(archive), '--rootfs', rootfs,
                                    '--archive-sha256', Path(rootfs).name))
    if receipt.get('normalizedTreeSha256') != tree:
        raise RuntimeError('rootfs mismatch')
    unit = 'oantuti-match-' + uuid.uuid4().hex + '.service'
    relative = '/system.slice/' + unit
    group = Path('/sys/fs/cgroup' + relative)
    identity = pwd.getpwnam('ha-thai')
    host = supervisor = reaper = None
    started = False
    with tempfile.TemporaryDirectory(prefix='match-', dir='/var/lib/oantuti/development') as temporary:
        work = Path(temporary)
        try:
            checked('systemd-run', '--quiet', '--unit=' + unit, '--service-type=exec',
                    '--property=Delegate=yes', '--property=DelegateSubgroup=anchor',
                    '--property=MemoryMax=1G', '--property=MemorySwapMax=0',
                    '--property=TasksMax=256', '--property=CPUQuota=200%',
                    '--property=RuntimeMaxSec=330', '--property=KillMode=control-group',
                    '/usr/bin/sleep', '325')
            started = True
            if checked('systemctl', 'show', unit, '--property=ControlGroup', '--value') != relative:
                raise RuntimeError('unexpected delegated cgroup')
            (group / 'cgroup.subtree_control').write_text('+cpu +memory +pids')
            (work / 'start.pb').write_bytes((installed / 'start.pb').read_bytes())
            (work / 'state').mkdir(mode=0o700)
            base = json.loads((installed / config_name).read_text())
            allowed = [
                ['/usr/bin/python3.12', '-B', '/opt/oantuti/sdk/python/starter_bot.py'],
                ['/opt/node/bin/node', '/opt/oantuti/artifacts/typescript/starter_bot.js'],
                ['/opt/oantuti/artifacts/cpp/starter_bot'],
            ]
            if base['root'] != {'path': rootfs, 'readonly': True} or base['process']['args'] not in allowed:
                raise RuntimeError('unexpected fixed workload')
            for side in ['white', 'black']:
                leaf = group / side
                leaf.mkdir()
                for name, value in [('memory.max', '268435456'), ('memory.swap.max', '0'), ('pids.max', '32'), ('cpu.max', '100000 100000')]:
                    (leaf / name).write_text(value)
                spec = copy.deepcopy(base)
                spec['linux']['cgroupsPath'] = relative + '/' + side
                bundle = work / side
                bundle.mkdir(mode=0o700)
                (bundle / 'config.json').write_text(json.dumps(spec))
            native_socket, host_socket = socket.socketpair()
            reaper_socket, heartbeat_socket = socket.socketpair()
            try:
                host_env = {'PATH': '/usr/bin:/bin', 'HOME': identity.pw_dir, 'LANG': 'C.UTF-8'}
                host = subprocess.Popen(['/home/ha-thai/.local/share/oantuti/toolchains/node-24.22.0/bin/node', '--import', 'tsx', 'packages/runner/bin/game-host.ts'],
                                        cwd='/home/ha-thai/OanTuTi', env=host_env, user=identity.pw_uid,
                                        group=identity.pw_gid, extra_groups=[], stdin=host_socket,
                                        stdout=subprocess.DEVNULL)
                host_socket.close()
                reaper = subprocess.Popen([str(installed / 'reaper'), str(group)], env=ENV,
                                          cwd='/', stdin=reaper_socket, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True)
                reaper_socket.close()
                supervisor = subprocess.Popen([str(installed / 'supervisor'), str(work), str(group)],
                                              env=ENV, cwd='/', stdin=native_socket,
                                              stdout=heartbeat_socket, stderr=subprocess.PIPE, text=True)
                native_socket.close()
                heartbeat_socket.close()
                _, errors = supervisor.communicate(timeout=320)
                if supervisor.returncode != 0:
                    raise RuntimeError('supervisor match failed: ' + errors[-2000:])
                host.wait(timeout=5)
                if host.returncode != 0:
                    raise RuntimeError('game host failed')
                reaper_output, reaper_errors = reaper.communicate(timeout=8)
                if reaper.returncode != 0 or 'MATCH_REAPER_CLEANUP_CONFIRMED' not in reaper_output:
                    raise RuntimeError('independent match reaper failed: ' + reaper_errors[-1000:])
                result = json.loads((work / 'game-evidence.json').read_text())
            finally:
                native_socket.close()
                host_socket.close()
                reaper_socket.close()
                heartbeat_socket.close()
        finally:
            for process in [supervisor, host]:
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=5)
            try:
                if reaper is not None:
                    try:
                        reaper.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        reaper.kill()
                        reaper.wait(timeout=3)
                        raise RuntimeError('reaper did not terminate; slot quarantined')
            finally:
                if started:
                    stopped = subprocess.run(['systemctl', 'stop', unit], env=ENV, cwd='/', capture_output=True, timeout=10)
                    if group.exists():
                        values = dict(line.split() for line in (group / 'cgroup.events').read_text().splitlines())
                        if values.get('populated') != '0':
                            raise RuntimeError('match descendants remain')
                    if stopped.returncode != 0 and group.exists():
                        raise RuntimeError('match unit failed to stop')
                    subprocess.run(['systemctl', 'reset-failed', unit], env=ENV, cwd='/', capture_output=True, timeout=5)
    return {'status': 'PASS', 'kernel': os.uname().release, 'match': result,
            'independentReaperConfirmed': True, 'gvisorCertified': False}


if __name__ == '__main__':
    import sys
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise SystemExit('root required; no arguments accepted')
    print(json.dumps(run_match()))
