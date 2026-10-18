#!/usr/bin/python3 -I
"""One-time promotion of the exact compiled-starter archive; no workload launch."""
import hashlib
import importlib.util
import json
from pathlib import Path
import posixpath
import tarfile

DIGEST = 'fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb'
TREE = 'b6305c27644a343ce1994b487e41bb1db46a332869b0f085c7b5f71a90d90d89'
base = Path(__file__).absolute().parent
archive = base / 'rootfs.tar'
target = Path('/var/lib/oantuti/development/rootfs') / DIGEST
h = hashlib.sha256()
with archive.open('rb') as stream:
    while chunk := stream.read(1048576):
        h.update(chunk)
if h.hexdigest() != DIGEST or target.exists():
    raise SystemExit('Archive mismatch or existing target; refusing promotion')
with tarfile.open(archive) as source:
    members = source.getmembers()
    names = set()
    for member in members:
        name = member.name.rstrip('/')
        if not name or name.startswith('/') or '..' in name.split('/') or name in names:
            raise SystemExit('Unsafe archive path')
        names.add(name)
        if not (member.isdir() or member.isfile() or member.issym() or member.islnk()):
            raise SystemExit('Unsafe archive member')
        if member.issym():
            parent = posixpath.dirname(name) or '.'
            resolved = posixpath.normpath(member.linkname.lstrip('/') if member.linkname.startswith('/') else posixpath.join(parent, member.linkname))
            if resolved == '..' or resolved.startswith('../'):
                raise SystemExit('Escaping link')
            member.linkname = posixpath.relpath(resolved, parent)
        if member.islnk() and (member.linkname.startswith('/') or '..' in member.linkname.split('/')):
            raise SystemExit('Unsafe hardlink')
        member.uid = member.gid = 0
        member.uname = member.gname = 'root'
        member.mode &= 0o1755
    target.mkdir(mode=0o755)
    source.extractall(target, members=members, filter='data')
    # tarfile's data filter intentionally adjusts directory metadata. Apply the
    # exact reviewed normalization after extraction; never follow symlinks.
    import os
    for member in members:
        path = target / member.name
        os.chown(path, 0, 0, follow_symlinks=False)
        if not member.issym():
            os.chmod(path, member.mode, follow_symlinks=False)
spec = importlib.util.spec_from_file_location('rootfs_verifier', base / 'verify-rootfs.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
result = verifier.verify(archive, target, DIGEST)
if result['normalizedTreeSha256'] != TREE:
    raise SystemExit('Normalized tree mismatch; target not approved')
print(json.dumps(result))
