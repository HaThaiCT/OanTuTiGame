#!/usr/bin/env python3
"""Local WAL archiving + point-in-time restore drill (S15 partial evidence).

Measures two things the release gates ask for, on the local development cluster only:

  * **RPO** — after a base backup plus archived WAL, does a transaction committed *after* the base
    backup survive a restore? The drill writes a marker row, forces a WAL switch, waits for the
    segment to land in the archive, restores into a fresh data directory and checks the marker.
  * **RTO** — how long the restore takes from `pg_ctl start` to the first successful query.

It is explicitly **not** an off-host drill: base backup, WAL archive and restored instance all live
on the same disk, and the archive is a local directory. The release requirement (off-host copy, key
custody, 35-day retention, backup-lag write fencing) stays PENDING_PROVIDER_T11.

Usage:
  deploy/linux/wal-restore-drill.py [--keep] [--archive-dir PATH] [--restore-dir PATH]

Environment overrides (defaults target the isolated rebuild development cluster):
  PGBIN, PGHOST (socket dir), PGPORT, PGDATABASE, PGSUPERUSER, ARCHIVE_DIR, RESTORE_DIR
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

TOOLCHAIN = Path('/home/ha-thai/.local/share/oantuti/toolchains/postgresql-16.15/usr')
DEFAULTS = {
    'PGBIN': str(TOOLCHAIN / 'lib/postgresql/16/bin'),
    'LD_LIBRARY_PATH': str(TOOLCHAIN / 'lib/x86_64-linux-gnu'),
    'PGHOST': '/home/ha-thai/.local/share/oantuti/rebuild/c72cd5a7-4f33-44ae-82da-723b6953024d/pg16/socket',
    'PGPORT': '55434',
    'PGDATABASE': 'arena_rebuild_c72cd5a74f33',
    'PGSUPERUSER': 'ha-thai',
    'BACKUP_ROLE': 'arena_rebuild_backup',
    'ARCHIVE_DIR': '/home/ha-thai/.local/share/oantuti/rebuild/c72cd5a7-4f33-44ae-82da-723b6953024d/pg16/wal-archive',
    'RESTORE_DIR': '/home/ha-thai/.local/share/oantuti/rebuild/c72cd5a7-4f33-44ae-82da-723b6953024d/pg16/wal-restore',
    'RESTORE_PORT': '55435',
}

ENV = dict(os.environ)
for key, value in DEFAULTS.items():
    ENV.setdefault(key, value)

PGBIN = Path(ENV['PGBIN'])
SOCKET = ENV['PGHOST']
PORT = ENV['PGPORT']
DATABASE = ENV['PGDATABASE']
SUPERUSER = ENV['PGSUPERUSER']
BACKUP_ROLE = ENV['BACKUP_ROLE']
ARCHIVE_DIR = Path(ENV['ARCHIVE_DIR'])
RESTORE_DIR = Path(ENV['RESTORE_DIR'])
RESTORE_PORT = ENV['RESTORE_PORT']
# Unix socket paths are capped at 107 bytes, and this workspace path is already long: the restored
# instance gets a short, drill-only socket directory under /tmp.
RESTORE_SOCKET = Path(ENV.get('RESTORE_SOCKET_DIR', '/tmp/oantuti-wal-restore-socket'))


def run(args: list[str], *, check: bool = True, timeout: int = 600) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, env=ENV, check=check, timeout=timeout)


def psql(
    sql: str,
    *,
    database: str = 'postgres',
    user: str | None = None,
    port: str | None = None,
    socket: str | None = None,
) -> str:
    result = run(
        [
            str(PGBIN / 'psql'),
            '-h',
            socket or SOCKET,
            '-p',
            port or PORT,
            '-U',
            user or SUPERUSER,
            '-d',
            database,
            '-tAc',
            sql,
        ]
    )
    return result.stdout.strip()


def psql_array(sql: str) -> list[str]:
    return [line for line in psql(sql).split('\n') if line]


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def configure_archiving() -> dict[str, object]:
    """Enable WAL archiving if it is off, and make sure the backup role may replicate."""
    settings: dict[str, object] = {}
    archive_mode = psql('SHOW archive_mode')
    settings['archiveModeBefore'] = archive_mode
    archive_command = f"cp %p {ARCHIVE_DIR}/%f"
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)

    role_replication = psql(
        f"SELECT rolreplication FROM pg_roles WHERE rolname = {sql_literal(BACKUP_ROLE)}"
    )
    if role_replication != 't':
        psql(f'ALTER ROLE {BACKUP_ROLE} REPLICATION')
        settings['grantedReplication'] = True

    if archive_mode != 'on':
        psql("ALTER SYSTEM SET archive_mode = 'on'")
        psql(f'ALTER SYSTEM SET archive_command = {sql_literal(archive_command)}')
        data_dir = psql('SHOW data_directory')
        run([str(PGBIN / 'pg_ctl'), '-D', data_dir, '-o', f"-k {SOCKET} -p {PORT}", '-l', str(Path(data_dir).parent / 'wal-drill-restart.log'), 'restart', '-w'])
        settings['restarted'] = True
    settings['archiveModeAfter'] = psql('SHOW archive_mode')
    settings['archiveCommand'] = psql('SHOW archive_command')
    return settings


def current_wal_position() -> tuple[str, str]:
    row = psql('SELECT pg_current_wal_lsn(), pg_current_wal_insert_lsn()').split('|')
    return row[0], row[1]


def wait_for_archive(until_lsn: str, timeout_seconds: int = 60) -> float:
    """Waits until the archive holds every segment needed to reach `until_lsn`."""
    started = time.monotonic()
    segment = psql(f"SELECT pg_walfile_name({sql_literal(until_lsn)})")
    while time.monotonic() - started < timeout_seconds:
        if (ARCHIVE_DIR / segment).exists():
            return time.monotonic() - started
        time.sleep(0.2)
    raise SystemExit(f'archive did not receive {segment} within {timeout_seconds}s')


def base_backup() -> dict[str, object]:
    if RESTORE_DIR.exists():
        shutil.rmtree(RESTORE_DIR)
    RESTORE_DIR.mkdir(parents=True)
    # PostgreSQL refuses to start from a data directory other local users can read.
    RESTORE_DIR.chmod(0o700)
    started = time.monotonic()
    result = run(
        [
            str(PGBIN / 'pg_basebackup'),
            '-h',
            SOCKET,
            '-p',
            PORT,
            '-U',
            BACKUP_ROLE,
            '-D',
            str(RESTORE_DIR),
            '-X',
            'stream',
            '-c',
            'fast',
            '-P',
        ]
    )
    duration = time.monotonic() - started
    size_bytes = sum(path.stat().st_size for path in RESTORE_DIR.rglob('*') if path.is_file())
    return {'seconds': round(duration, 3), 'bytes': size_bytes, 'stdoutTail': result.stderr.strip().split('\n')[-1]}


def restore_and_measure(marker: str) -> dict[str, object]:
    auto_conf = RESTORE_DIR / 'postgresql.auto.conf'
    with auto_conf.open('a') as handle:
        handle.write(
            '\n# wal-restore-drill overrides\n'
            f"restore_command = 'cp {ARCHIVE_DIR}/%f %p'\n"
            'archive_mode = off\n'
            f'port = {RESTORE_PORT}\n'
            f"unix_socket_directories = '{RESTORE_SOCKET}'\n"
            "listen_addresses = ''\n"
        )
    (RESTORE_DIR / 'recovery.signal').write_text('')

    RESTORE_SOCKET.mkdir(parents=True, exist_ok=True)
    log_path = RESTORE_DIR.parent / 'wal-restore-start.log'
    started = time.monotonic()
    run([str(PGBIN / 'pg_ctl'), '-D', str(RESTORE_DIR), '-l', str(log_path), 'start', '-w', '-t', '60'])
    start_seconds = time.monotonic() - started

    marker_query = (
        f"SELECT value->>'marker' FROM deployment_settings WHERE key = 'wal_drill_marker'"
    )
    value = ''
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            value = psql(
                marker_query, database=DATABASE, user=SUPERUSER, port=RESTORE_PORT, socket=str(RESTORE_SOCKET)
            )
            break
        except subprocess.CalledProcessError:
            time.sleep(0.3)
    ready_seconds = time.monotonic() - started

    counts = psql(
        'SELECT (SELECT count(*) FROM users) || \'/\' || (SELECT count(*) FROM games) || \'/\' || '
        "(SELECT count(*) FROM encounters)",
        database=DATABASE,
        user=SUPERUSER,
        port=RESTORE_PORT,
        socket=str(RESTORE_SOCKET),
    )
    run([str(PGBIN / 'pg_ctl'), '-D', str(RESTORE_DIR), 'stop', '-m', 'fast', '-w'], check=False)
    return {
        'pgCtlStartSeconds': round(start_seconds, 3),
        'queryReadySeconds': round(ready_seconds, 3),
        'markerFound': value == marker,
        'markerValue': value,
        'rowCountsUsersGamesEncounters': counts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description='Local WAL archive + restore drill (not off-host).')
    parser.add_argument('--keep', action='store_true', help='keep the restored data directory and archive')
    parser.add_argument(
        '--no-heartbeat',
        action='store_true',
        help='do not record the successful backup heartbeat the write fence reads',
    )
    parser.add_argument('--out', default=str(Path(__file__).resolve().parents[2] / 'docs/implementation/rebuild/S15-wal-restore-drill.json'))
    args = parser.parse_args()

    manifest: dict[str, object] = {
        'schemaVersion': 1,
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'status': 'LOCAL_WAL_RESTORE_DRILL_NOT_OFF_HOST',
        'offHost': False,
        'cluster': {
            'socket': SOCKET,
            'port': PORT,
            'database': DATABASE,
            'superuser': SUPERUSER,
            'backupRole': BACKUP_ROLE,
            'archiveDir': str(ARCHIVE_DIR),
            'restoreDir': str(RESTORE_DIR),
            'restorePort': RESTORE_PORT,
            'postgresVersion': psql('SHOW server_version'),
            'dataDirectory': psql('SHOW data_directory'),
        },
    }

    manifest['archiving'] = configure_archiving()

    base_lsn, _ = current_wal_position()
    base = base_backup()
    manifest['baseBackup'] = base

    # A transaction committed after the base backup must survive the restore (RPO check).
    marker = uuid.uuid4().hex
    psql(
        "INSERT INTO deployment_settings (key, value, updated_at) "
        f"VALUES ('wal_drill_marker', jsonb_build_object('marker', {sql_literal(marker)}, "
        f"'writtenAt', now()::text), now()) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        database=DATABASE,
    )
    marker_lsn, _ = current_wal_position()
    psql('SELECT pg_switch_wal()')
    archive_wait = wait_for_archive(marker_lsn)
    manifest['recovery'] = {
        'baseBackupLsn': base_lsn,
        'markerLsn': marker_lsn,
        'segmentArchivedAfterSeconds': round(archive_wait, 3),
        'archivedSegments': len(list(ARCHIVE_DIR.glob('*'))),
    }

    manifest['restore'] = restore_and_measure(marker)

    # The marker belongs to the drill, not to the data set: remove it from the live cluster.
    psql("DELETE FROM deployment_settings WHERE key = 'wal_drill_marker'", database=DATABASE)

    # A verified restore is a completed backup: publish the heartbeat the protected-write fence reads.
    if manifest['restore']['markerFound'] and not args.no_heartbeat:
        psql(
            "INSERT INTO deployment_settings (key, value, updated_at) "
            "VALUES ('backup_status', jsonb_build_object('lastSuccessAt', now()::text, "
            "'source', 'wal-restore-drill'), now()) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            database=DATABASE,
        )
        manifest['heartbeat'] = {'recorded': True, 'key': 'backup_status'}

    if not args.keep:
        shutil.rmtree(RESTORE_DIR, ignore_errors=True)
        shutil.rmtree(RESTORE_SOCKET, ignore_errors=True)
    manifest['rpo'] = {
        'transactionsCommittedAfterBaseBackupSurvived': bool(manifest['restore']['markerFound']),
        'note': 'Archive is a local directory; the same drill must run against the off-host copy to certify RPO <= 5 min.',
    }
    manifest['rto'] = {
        'measuredSeconds': manifest['restore']['queryReadySeconds'],
        'target': '<= 1800 s',
        'note': 'Local restore with a warm page cache on the same disk; not the release-host figure.',
    }
    manifest['notMeasured'] = [
        'off-host transfer, immutable object inventory and GC holds',
        'key custody, signed manifest and 35-day retention',
        'backup-lag > 5 min write fencing and archive failure alerting',
        'restore onto the declared GA 6.8 release host and its storage layout',
        'a 249,500-game data volume (this drill restores a 16 MB development database)',
    ]

    Path(args.out).write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
