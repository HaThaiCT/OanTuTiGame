#!/usr/bin/env python3
"""Read-only verification of a normalized, root-owned rootfs against its tar."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import tarfile
from contextlib import ExitStack


class VerificationError(Exception):
    pass


def digest(stream):
    value = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        value.update(chunk)
    return value.hexdigest()


def canonical_path(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or '..' in path.parts or str(path) != value.rstrip('/') or str(path) == '.':
        raise VerificationError('INVALID_ARCHIVE_PATH')
    return str(path)


def verify(archive, rootfs, expected_digest, expected_uid=0, expected_gid=0):
    if not re.fullmatch('[0-9a-f]{64}', expected_digest):
        raise VerificationError('INVALID_ARCHIVE_DIGEST')
    rootfs = Path(rootfs).absolute()
    for ancestor in [rootfs, *rootfs.parents]:
        info = ancestor.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, expected_uid} or info.st_gid not in {0, expected_gid} or info.st_mode & 0o6022:
            raise VerificationError('UNSAFE_ROOTFS_ANCESTOR')
    records = []
    with open(archive, 'rb') as stream, ExitStack() as resources:
        if digest(stream) != expected_digest:
            raise VerificationError('ARCHIVE_DIGEST_MISMATCH')
        stream.seek(0)
        source = resources.enter_context(tarfile.open(fileobj=stream, mode='r:'))
        members = source.getmembers()
        by_name = {}
        for member in members:
            name = canonical_path(member.name)
            if name in by_name:
                raise VerificationError('DUPLICATE_ARCHIVE_PATH')
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise VerificationError('UNSUPPORTED_ARCHIVE_TYPE')
            by_name[name] = member
        for name in sorted(by_name):
            member = by_name[name]
            for parent in PurePosixPath(name).parents:
                if str(parent) != '.' and (str(parent) not in by_name or not by_name[str(parent)].isdir()):
                    raise VerificationError('INVALID_ARCHIVE_PARENT')
                if str(parent) != '.' and not stat.S_ISDIR((rootfs / str(parent)).lstat().st_mode):
                    raise VerificationError('UNSAFE_ROOTFS_PARENT')
            path = rootfs / name
            info = path.lstat()
            if info.st_uid != expected_uid or info.st_gid != expected_gid:
                raise VerificationError('OWNERSHIP_MISMATCH')
            record = {'path': name, 'uid': info.st_uid, 'gid': info.st_gid}
            if member.issym():
                parent = posixpath.dirname(name) or '.'
                resolved = posixpath.normpath(member.linkname.lstrip('/') if member.linkname.startswith('/') else posixpath.join(parent, member.linkname))
                if resolved == '..' or resolved.startswith('../'):
                    raise VerificationError('ESCAPING_ARCHIVE_LINK')
                normalized = posixpath.relpath(resolved, parent)
                if not stat.S_ISLNK(info.st_mode) or os.readlink(path) != normalized:
                    raise VerificationError('SYMLINK_MISMATCH')
                record.update(type='symlink', target=normalized)
            else:
                mode = stat.S_IMODE(info.st_mode)
                if mode != member.mode & 0o1755:
                    raise VerificationError('MODE_MISMATCH')
                record['mode'] = mode
                if member.isdir():
                    if not stat.S_ISDIR(info.st_mode):
                        raise VerificationError('TYPE_MISMATCH')
                    record['type'] = 'directory'
                else:
                    if not stat.S_ISREG(info.st_mode):
                        raise VerificationError('TYPE_MISMATCH')
                    if member.islnk():
                        link = canonical_path(member.linkname)
                        if link not in by_name or not by_name[link].isfile():
                            raise VerificationError('INVALID_HARDLINK')
                    with source.extractfile(member) as original, path.open('rb') as installed:
                        content_digest = digest(installed)
                        if content_digest != digest(original):
                            raise VerificationError('CONTENT_MISMATCH')
                    record.update(type='file', size=info.st_size, sha256=content_digest)
            records.append(record)
    actual = set()
    def walk_error(error):
        raise error
    for directory, dirs, files in os.walk(rootfs, followlinks=False, onerror=walk_error):
        for name in dirs + files:
            actual.add(str((Path(directory) / name).relative_to(rootfs)))
    if actual != set(by_name):
        raise VerificationError('ROOTFS_PATH_SET_MISMATCH')
    canonical = json.dumps(records, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
    return {'schemaVersion': 1, 'status': 'VERIFIED', 'memberCount': len(records),
            'archiveSha256': expected_digest, 'normalizedTreeSha256': hashlib.sha256(canonical).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--rootfs', required=True)
    parser.add_argument('--archive-sha256', required=True)
    args = parser.parse_args()
    try:
        result = verify(args.archive, args.rootfs, args.archive_sha256)
    except (VerificationError, OSError, tarfile.TarError, ValueError) as error:
        code = str(error) if isinstance(error, VerificationError) else type(error).__name__
        print(json.dumps({'status': 'REJECTED', 'code': code}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
