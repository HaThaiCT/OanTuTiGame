#!/usr/bin/env python3
"""Fixed development sleep probe only. Does not launch or certify a sandbox."""
import json
import sys

ROOTFS = '/var/lib/oantuti/development/rootfs/63768f52c0ba59396b40aabfa6ced7650d5f7b309ba09d9e606b7189eb3865b4'


def build_spec():
    return {
        'ociVersion': '1.2.0',
        'root': {'path': ROOTFS, 'readonly': True},
        'process': {
            'terminal': False,
            'user': {'uid': 65534, 'gid': 65534, 'additionalGids': []},
            'args': ['/usr/bin/sleep', '0'],
            'cwd': '/',
            'env': ['PATH=/usr/bin:/bin'],
            'noNewPrivileges': True,
            'capabilities': {name: [] for name in ['bounding', 'effective', 'inheritable', 'permitted', 'ambient']},
            'rlimits': [{'type': 'RLIMIT_NOFILE', 'hard': 64, 'soft': 64}],
        },
        'mounts': [
            {'destination': '/proc', 'type': 'proc', 'source': 'proc', 'options': ['nosuid', 'nodev', 'noexec']},
            {'destination': '/tmp', 'type': 'tmpfs', 'source': 'tmpfs',
             'options': ['nosuid', 'nodev', 'noexec', 'mode=1777', 'size=16777216']},
        ],
        'linux': {
            'namespaces': [{'type': name} for name in ['pid', 'network', 'ipc', 'uts', 'mount']],
            'resources': {
                # OCI swap is total memory+swap, unlike memory.swap.max.
                'memory': {'limit': 268435456, 'swap': 268435456},
                'pids': {'limit': 32},
                'cpu': {'quota': 100000, 'period': 100000},
                'devices': [{'allow': False, 'access': 'rwm'}],
            },
            'maskedPaths': ['/proc/kcore', '/proc/keys', '/proc/timer_list', '/proc/sysrq-trigger'],
            'readonlyPaths': ['/proc/sys', '/proc/irq', '/proc/bus'],
        },
        'annotations': {'org.oantuti.purpose': 'development-trusted-sleep-only'},
    }


if __name__ == '__main__':
    if len(sys.argv) != 1:
        raise SystemExit('REJECTED: no arguments accepted')
    print(json.dumps(build_spec(), sort_keys=True))
