#!/usr/bin/env python3
"""Read-only host inventory. Presence is not sandbox certification; never changes host settings."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path.cwd())
parser.add_argument('--rust-bin', type=Path)
parser.add_argument('--runsc', type=Path)
args = parser.parse_args()
root = args.root.resolve(strict=True)

def binary_info(path):
    if not path or not Path(path).is_file():
        return {'present': False}
    p = Path(path).resolve(strict=True)
    try:
        result = subprocess.run([str(p), '--version'], capture_output=True, text=True, timeout=5)
        version = (result.stdout or result.stderr).strip()[:500]
        return {'present': True, 'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'version': version, 'exitCode': result.returncode}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'present': True, 'path': str(p), 'error': type(error).__name__}

kernel = platform.release()
disk = shutil.disk_usage(root)
cgroup = Path('/sys/fs/cgroup')
report = {
    'schemaVersion': 1,
    'profile': 'LAN_OFFLINE',
    'root': str(root),
    'host': {'kernel': kernel, 'architecture': platform.machine(), 'uid': os.getuid()},
    'disk': {'totalBytes': disk.total, 'freeBytes': disk.free},
    'cgroupV2Present': (cgroup / 'cgroup.controllers').is_file(),
    'tools': {
        'cargo': binary_info(args.rust_bin / 'cargo' if args.rust_bin else shutil.which('cargo')),
        'rustc': binary_info(args.rust_bin / 'rustc' if args.rust_bin else shutil.which('rustc')),
        'runsc': binary_info(args.runsc or shutil.which('runsc')),
    },
    'baselineKernelMatches': kernel.startswith('6.8.'),
    'executionReady': False,
    'releaseReady': False,
    'pendingProof': ['actual delegated cgroup/resource enforcement', 'per-job sandbox canaries and external reaper', 'UID-authenticated native workload consumer', 'LAN CA/cold-client WAN-deny journey', 'verified off-host recovery', 'mixed capacity and real-clock endurance', 'independent security and user sign-off'],
}
print(json.dumps(report, indent=2))
