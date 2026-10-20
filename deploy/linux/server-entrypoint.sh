#!/bin/sh
set -eu
umask 077
if [ -z "${PGPASSWORD_FILE:-}" ] || [ ! -r "$PGPASSWORD_FILE" ]; then
  echo 'PGPASSWORD_FILE must name a readable application database secret' >&2
  exit 1
fi
PGPASSWORD=$(cat "$PGPASSWORD_FILE")
if [ -z "$PGPASSWORD" ]; then
  echo 'Application database secret must not be empty' >&2
  exit 1
fi
export PGPASSWORD

# Never inherit the archive's workstation uid, modes or broad storage-directory permissions.
# Validate every member before writing, and do not merge a bundled demo into existing objects.
python3 - <<'PY'
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile

storage = Path('/app/storage')
roots = {name: storage / name for name in ('replays', 'submissions', 'bots', 'execution')}
for root in (storage, *roots.values()):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise SystemExit('Storage roots must be real directories owned by the service identity')
    root.chmod(0o700)

archive = Path('/app/deploy/demo-data/arena_objects.tar.gz')
pending = storage / '.demo-objects-installing'
if pending.exists():
    raise SystemExit('Interrupted demo object installation; recover the storage volume before restarting')
if archive.is_file():
    empty = all(not any(roots[name].iterdir()) for name in ('replays', 'submissions'))
    if empty:
        with tarfile.open(archive, 'r:gz') as bundle:
            members = bundle.getmembers()
            seen = set()
            for member in members:
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or str(path) in seen:
                    raise SystemExit('Unsafe or duplicate demo archive member')
                seen.add(str(path))
                if member.isdir() and str(path) in ('storage', 'storage/replays', 'storage/submissions'):
                    continue
                valid = (member.isfile() and len(path.parts) == 3 and path.parts[0] == 'storage'
                         and path.parts[1] in ('replays', 'submissions')
                         and re.fullmatch(r'[0-9a-f]{64}\.' + ('oantuti' if path.parts[1] == 'replays' else 'zip'), path.name))
                if not valid:
                    raise SystemExit('Unexpected demo archive member')
            pending.touch(mode=0o600, exist_ok=False)
            for member in members:
                if not member.isfile():
                    continue
                destination = storage / PurePosixPath(member.name).relative_to('storage')
                with bundle.extractfile(member) as source, destination.open('xb') as target:
                    shutil.copyfileobj(source, target)
                destination.chmod(0o600)
            pending.unlink()
PY

exec node --import tsx packages/server/src/index.ts
