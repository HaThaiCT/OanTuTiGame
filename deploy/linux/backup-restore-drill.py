#!/usr/bin/env python3
"""Local backup/restore drill for the isolated rebuild cluster.

This is deliberately NOT off-host certification: the dump and object archive are written under
the same host. It proves the mechanical path (consistent pg_dump, object inventory, restore into a
fresh database, row-count checks) so the off-host step only has to change the destination and
transport. Every path is passed explicitly; no donor path is touched.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path

PG_BIN = Path('/home/ha-thai/.local/share/oantuti/toolchains/postgresql-16.15/usr/lib/postgresql/16/bin')
LD_PATH = '/home/ha-thai/.local/share/oantuti/toolchains/postgresql-16.15/usr/lib/x86_64-linux-gnu'


def run(cmd, env, **kwargs):
    return subprocess.run(cmd, text=True, capture_output=True, env=env, **kwargs)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        while chunk := handle.read(65536):
            digest.update(chunk)
    return digest.hexdigest()


def table_counts(psql: Path, env: dict, socket: Path, port: int, user: str, database: str) -> dict:
    tables = [
        'users', 'teams', 'tournaments', 'tournament_entries', 'submissions',
        'games', 'accepted_results', 'replay_objects', 'standings_snapshots', 'rating_events',
    ]
    counts = {}
    for table in tables:
        result = run([str(psql), '-h', str(socket), '-p', str(port), '-U', user, '-d', database, '-tAc', f'SELECT count(*) FROM {table};'], env)
        if result.returncode != 0:
            raise RuntimeError(f'count {table}: {result.stderr}')
        counts[table] = int(result.stdout.strip())
    return counts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--database', required=True)
    parser.add_argument('--user', default='arena_rebuild_migrator')
    parser.add_argument('--objects', action='append', default=[])
    parser.add_argument('--output', required=True)
    parser.add_argument('--restore-database', default='arena_restore_drill')
    args = parser.parse_args()

    env = {**os.environ, 'LD_LIBRARY_PATH': LD_PATH}
    socket = Path(args.socket)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    psql = PG_BIN / 'psql'
    started = time.time()

    dump = output / f'{args.database}.sql'
    backup = run([
        str(PG_BIN / 'pg_dump'), '-h', str(socket), '-p', str(args.port), '-U', args.user,
        '-d', args.database, '--clean', '--if-exists', '-f', str(dump),
    ], env)
    if backup.returncode != 0:
        raise RuntimeError(f'pg_dump failed: {backup.stderr}')

    objects_archive = output / 'objects.tar.gz'
    with tarfile.open(objects_archive, 'w:gz') as archive:
        for root in args.objects:
            archive.add(root, arcname=Path(root).name)
    backup_seconds = round(time.time() - started, 2)

    source_counts = table_counts(psql, env, socket, args.port, args.user, args.database)

    # Restore into a fresh database on the same cluster (mechanical drill only).
    admin = run([str(psql), '-h', str(socket), '-p', str(args.port), '-U', 'ha-thai', '-d', args.database, '-tAc',
                 f'DROP DATABASE IF EXISTS {args.restore_database};'], env)
    if admin.returncode != 0:
        raise RuntimeError(f'drop restore db: {admin.stderr}')
    create = run([str(psql), '-h', str(socket), '-p', str(args.port), '-U', 'ha-thai', '-d', args.database, '-tAc',
                  f'CREATE DATABASE {args.restore_database};'], env)
    if create.returncode != 0:
        raise RuntimeError(f'create restore db: {create.stderr}')
    restore = run([str(psql), '-h', str(socket), '-p', str(args.port), '-U', args.user, '-d', args.restore_database,
                   '-v', 'ON_ERROR_STOP=1', '-f', str(dump)], env)
    if restore.returncode != 0:
        raise RuntimeError(f'restore failed: {restore.stderr}')
    restored_counts = table_counts(psql, env, socket, args.port, args.user, args.restore_database)

    manifest = {
        'database': args.database,
        'restoreDatabase': args.restore_database,
        'backupSeconds': backup_seconds,
        'dumpSha256': sha256(dump),
        'dumpBytes': dump.stat().st_size,
        'objectsSha256': sha256(objects_archive),
        'objectsBytes': objects_archive.stat().st_size,
        'sourceCounts': source_counts,
        'restoredCounts': restored_counts,
        'countsMatch': source_counts == restored_counts,
        'offHost': False,
    }
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

    # Leave the restore DB only long enough to inspect it in this drill, then remove it.
    run([str(psql), '-h', str(socket), '-p', str(args.port), '-U', 'ha-thai', '-d', args.database, '-tAc',
         f'DROP DATABASE IF EXISTS {args.restore_database};'], env)
    print(json.dumps(manifest, indent=2))
    return 0 if manifest['countsMatch'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
