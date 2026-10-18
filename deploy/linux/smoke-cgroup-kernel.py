#!/usr/bin/env python3
"""Operator-only trusted cgroup-v2 transition smoke; no Bot or sandbox launch."""
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
import pwd
import argparse
import stat
import socket
import sys
import select


def exercise_reaper(native, workload, child_pid):
    reader, writer = socket.socketpair()
    reaper = None
    owner = None
    try:
        reaper = subprocess.Popen([str(native), str(workload), str(child_pid)],
                                  stdin=reader, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        reader.close()
        # Only this finite trusted fixture owns the writer. The test harness and
        # reaper must close their copies so SIGKILL causes EOF independently.
        code = ('import os,socket,sys,time; '
                's=socket.socket(fileno=int(sys.argv[1])); '
                's.sendall(bytes([0])); print("HEARTBEAT_READY",flush=True); '
                'time.sleep(20)')
        owner = subprocess.Popen([sys.executable, '-c', code, str(writer.fileno())],
                                 pass_fds=(writer.fileno(),), stdout=subprocess.PIPE, text=True)
        writer.close()
        if not select.select([owner.stdout], [], [], 5)[0]:
            raise RuntimeError('trusted supervisor heartbeat readiness timeout')
        if owner.stdout.readline().strip() != 'HEARTBEAT_READY':
            raise RuntimeError('trusted supervisor fixture did not arm heartbeat')
        owner.kill()
        owner.wait(timeout=3)
        output, errors = reaper.communicate(timeout=8)
        if reaper.returncode != 0:
            raise RuntimeError('native reaper cleanup failed')
        result = json.loads(output)
        if result != {'status': 'PASS', 'reaper': 'rust', 'cause': 'Disconnected',
                      'zeroDescendantsConfirmed': True}:
            raise RuntimeError('reaper did not confirm supervisor-death cleanup')
        return result
    finally:
        reader.close()
        writer.close()
        for process in (owner, reaper):
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=3)
        if owner is not None and owner.stdout is not None:
            owner.stdout.close()


def trusted_executable(value):
    path = Path(value).absolute()
    for parent in [path, *path.parents]:
        info = parent.lstat()
        if info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o6022 or stat.S_ISLNK(info.st_mode):
            raise RuntimeError('native controller must have root-owned immutable ancestors')
    if not path.is_file() or not os.access(path, os.X_OK):
        raise RuntimeError('invalid native controller executable')
    return path


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def wait_state(path, key, value, timeout=3):
    deadline = time.monotonic() + timeout
    while True:
        fields = dict(line.split() for line in (path / 'cgroup.events').read_text().splitlines())
        if fields.get(key) == value:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('cgroup transition timeout')
        time.sleep(0.001)

def exercise_workload(path):
    wait_state(path, 'populated', '1')
    (path / 'cgroup.freeze').write_text('1')
    wait_state(path, 'frozen', '1')
    (path / 'cgroup.freeze').write_text('0')
    wait_state(path, 'frozen', '0')
    (path / 'cgroup.kill').write_text('1')
    wait_state(path, 'populated', '0')



def main():
    if os.geteuid() != 0:
        raise SystemExit('REJECTED: operator root authentication required')
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--native-controller')
    mode.add_argument('--native-reaper')
    args = parser.parse_args()
    native = trusted_executable(args.native_controller) if args.native_controller else None
    native_reaper = trusted_executable(args.native_reaper) if args.native_reaper else None
    unit = 'oantuti-kernel-smoke-' + uuid.uuid4().hex + '.service'
    started = False
    child = None
    workload = None
    try:
        run('systemd-run', '--quiet', '--unit=' + unit, '--service-type=exec',
            '--property=MemoryMax=64M', '--property=MemorySwapMax=0',
            '--property=TasksMax=8', '--property=CPUQuota=100%',
            '--property=RuntimeMaxSec=30', '--property=KillMode=control-group',
            '--property=Delegate=yes',
            '--property=PrivateNetwork=yes', '--property=NoNewPrivileges=yes',
            '--property=ProtectSystem=strict', '--property=ProtectHome=yes',
            '--property=User=arena-supervisor', '/usr/bin/sleep', '25')
        started = True
        relative = run('systemctl', 'show', unit, '--property=ControlGroup', '--value')
        expected = '/system.slice/' + unit
        if relative != expected:
            raise RuntimeError('unexpected scope path; refusing cgroup writes')
        pid = int(run('systemctl', 'show', unit, '--property=MainPID', '--value'))
        if pid <= 1 or Path('/proc/' + str(pid) + '/cgroup').read_text().strip() != '0::' + relative:
            raise RuntimeError('unexpected process membership')
        path = Path('/sys/fs/cgroup') / relative.lstrip('/')
        if path.is_symlink() or not path.is_dir():
            raise RuntimeError('invalid test cgroup')
        # Keep systemd's MainPID alive in the parent until child-group emptiness
        # is observed. An open FD does not pin a removed cgroup's event interface.
        workload = path / 'trusted-workload'
        workload.mkdir()
        identity = pwd.getpwnam('arena-supervisor')
        child = subprocess.Popen(['/usr/bin/sleep', '20'], user=identity.pw_uid,
                                 group=identity.pw_gid, extra_groups=[])
        (workload / 'cgroup.procs').write_text(str(child.pid))
        if Path('/proc/' + str(child.pid) + '/cgroup').read_text().strip() != '0::' + relative + '/trusted-workload':
            raise RuntimeError('unexpected child membership; refusing transition test')
        if native_reaper is not None:
            exercise_reaper(native_reaper, workload, child.pid)
        elif native is None:
            exercise_workload(workload)
        else:
            result = json.loads(run(str(native), str(workload), str(child.pid)))
            if result != {'status': 'PASS', 'controller': 'rust', 'frozenConfirmed': True,
                          'unfrozenConfirmed': True, 'zeroDescendantsConfirmed': True}:
                raise RuntimeError('native controller did not confirm all transitions')
        child.wait(timeout=3)
        workload.rmdir()
        workload = None
        report = {'status': 'PASS', 'unit': unit, 'kernel': os.uname().release,
                  'controller': 'rust' if native is not None else 'python',
                  'zeroDescendantsConfirmed': True, 'botExecuted': False,
                  'gvisorCertified': False}
        if native_reaper is None:
            report.update(frozenConfirmed=True, unfrozenConfirmed=True)
        else:
            report.update(controller='rust-reaper', supervisorSigkillConfirmed=True)
        print(json.dumps(report))
    finally:
        try:
            if child is not None:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=3)
        finally:
            try:
                if workload is not None and workload.exists():
                    workload.rmdir()
            finally:
                if started:
                    subprocess.run(['systemctl', 'stop', unit], check=True)
                    subprocess.run(['systemctl', 'reset-failed', unit], check=False, capture_output=True)


if __name__ == '__main__':
    main()
