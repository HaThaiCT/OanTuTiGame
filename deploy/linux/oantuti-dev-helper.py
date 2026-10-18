#!/usr/bin/python3 -I
"""Fixed-action development helper. No caller-supplied paths or command options."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

BUNDLE = Path('/usr/local/libexec/oantuti/dev-helper-v1')
ARCHIVE_DIGEST = '63768f52c0ba59396b40aabfa6ced7650d5f7b309ba09d9e606b7189eb3865b4'
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/root'}


def trusted(path):
    for entry in [path, *path.parents]:
        info = entry.lstat()
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o6022:
            raise ValueError('UNSAFE_PRIVILEGED_PATH')
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('NOT_REGULAR_FILE')


def command(action):
    if action == 'verify-rootfs':
        return ['/usr/bin/python3', '-I', str(BUNDLE / 'verify-rootfs.py'),
                '--archive', str(BUNDLE / 'rootfs.tar'),
                '--rootfs', '/var/lib/oantuti/development/rootfs/' + ARCHIVE_DIGEST,
                '--archive-sha256', ARCHIVE_DIGEST]
    if action in ('smoke-controller', 'smoke-reaper'):
        option, binary = ('--native-controller', 'controller') if action == 'smoke-controller' else ('--native-reaper', 'reaper')
        return ['/usr/bin/python3', '-I', str(BUNDLE / 'smoke-cgroup-kernel.py'), option, str(BUNDLE / binary)]
    raise ValueError('ACTION_DENIED')


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError('ARGUMENTS_DENIED')
        argv = command(sys.argv[1])
        if os.geteuid() != 0:
            raise ValueError('ROOT_AUTHENTICATION_REQUIRED')
        trusted(Path(__file__).absolute())
        manifest_path = BUNDLE / 'manifest.json'
        trusted(manifest_path)
        manifest = json.loads(manifest_path.read_text())
        required = {'verify-rootfs.py', 'smoke-cgroup-kernel.py', 'controller', 'reaper'}
        if set(manifest) != required:
            raise ValueError('INVALID_BUNDLE_MANIFEST')
        for name in sorted(required):
            path = BUNDLE / name
            trusted(path)
            if hashlib.sha256(path.read_bytes()).hexdigest() != manifest[name]:
                raise ValueError('BUNDLE_INTEGRITY_FAILURE')
        if sys.argv[1] == 'verify-rootfs':
            trusted(BUNDLE / 'rootfs.tar')
        # Serialize operator development smoke actions; never run overlapping
        # systemd fixtures from concurrent helper calls.
        import fcntl
        lock_path = BUNDLE / 'operation.lock'
        trusted(lock_path)
        with lock_path.open('r') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return subprocess.run(argv, env=ENV, cwd='/', stdin=subprocess.DEVNULL,
                                  timeout=90, check=False).returncode
    except (ValueError, OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        print(json.dumps({'status': 'REJECTED', 'code': str(error) if isinstance(error, ValueError) else type(error).__name__}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
