#!/usr/bin/python3 -I
"""Run the same fixed starter match for Python, compiled TypeScript, and C++20."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

ARCHIVE = 'fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb'
TREE = 'b6305c27644a343ce1994b487e41bb1db46a332869b0f085c7b5f71a90d90d89'


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise SystemExit('root required; no arguments accepted')
    base = Path(__file__).absolute().parent
    manifest = base / 'manifest.json'
    for path in [Path(__file__).absolute(), manifest, base / 'trusted-match.py']:
        for entry in [path, *path.parents]:
            info = entry.lstat()
            if info.st_uid != 0 or info.st_gid != 0 or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o6022:
                raise RuntimeError('unsafe match installation')
    hashes = json.loads(manifest.read_text())
    for name in ['trusted-match.py', 'verify-rootfs.py']:
        path = base / name
        for entry in [path, *path.parents]:
            info = entry.lstat()
            if info.st_uid != 0 or info.st_gid != 0 or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o6022:
                raise RuntimeError('unsafe runtime dependency')
        if hashlib.sha256(path.read_bytes()).hexdigest() != hashes[name]:
            raise RuntimeError('runtime dependency digest mismatch')
    spec = importlib.util.spec_from_file_location('trusted_match', base / 'trusted-match.py')
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)
    results = []
    for language in ['python', 'typescript', 'cpp']:
        result = launcher.run_match('config-' + language + '.json',
                                    '/var/lib/oantuti/development/rootfs/' + ARCHIVE,
                                    TREE, base / 'rootfs.tar')
        result['language'] = language
        results.append(result)
    print(json.dumps({'status': 'PASS', 'matches': results, 'gvisorCertified': False}))


if __name__ == '__main__':
    main()
