#!/usr/bin/python3 -I
"""Prepare and safely publish the pinned native compiler rootfs."""
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import posixpath
import shutil
import stat
import tarfile
import tempfile

DIGEST = '626e4e3c7f82a95dfec96954b6909543ef38159833b0ae9a061ce71100de0730'
TREE = '583027582ce2f76c98eb0317659c7b663ed31bc57cd9c155afc9e5f83aa5705b'
TARGET = Path('/var/lib/oantuti/development/toolchains') / DIGEST

class PromotionError(Exception):
    pass

def load_verifier(path):
    spec = importlib.util.spec_from_file_location('rootfs_verifier', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def verify(archive, root, expected_digest=DIGEST, expected_tree=TREE, verifier_path=None, owner_uid=0, owner_gid=0):
    verifier_path = Path(verifier_path) if verifier_path else Path(__file__).absolute().parent / 'verify-rootfs.py'
    result = load_verifier(verifier_path).verify(archive, root, expected_digest, owner_uid, owner_gid)
    if result['normalizedTreeSha256'] != expected_tree:
        raise PromotionError('Compiler normalized tree mismatch')
    return result

def prepare(archive, stage, expected_digest=DIGEST, expected_tree=TREE, verifier_path=None, owner_uid=0, owner_gid=0):
    archive, stage = Path(archive), Path(stage)
    h = hashlib.sha256()
    with archive.open('rb') as stream:
        while chunk := stream.read(1048576):
            h.update(chunk)
    if h.hexdigest() != expected_digest:
        raise PromotionError('Compiler archive mismatch')
    if stage.exists() or stage.is_symlink():
        raise PromotionError('Preparation target exists')
    stage.mkdir(mode=0o700)
    try:
        with tarfile.open(archive) as source:
            members = source.getmembers()
            names = set()
            for member in members:
                name = member.name.rstrip('/')
                if not name or name.startswith('/') or '..' in name.split('/') or name in names:
                    raise PromotionError('Unsafe archive path')
                names.add(name)
                if not (member.isdir() or member.isfile() or member.issym() or member.islnk()):
                    raise PromotionError('Unsafe archive member')
                if member.issym():
                    parent = posixpath.dirname(name) or '.'
                    resolved = posixpath.normpath(member.linkname.lstrip('/') if member.linkname.startswith('/') else posixpath.join(parent, member.linkname))
                    if resolved == '..' or resolved.startswith('../'):
                        raise PromotionError('Escaping link')
                    member.linkname = posixpath.relpath(resolved, parent)
                if member.islnk() and (member.linkname.startswith('/') or '..' in member.linkname.split('/')):
                    raise PromotionError('Unsafe hardlink')
                member.uid, member.gid = owner_uid, owner_gid
                member.uname = member.gname = ''
                member.mode &= 0o1755
            source.extractall(stage, members=members, filter='data')
            for member in members:
                path = stage / member.name
                os.chown(path, owner_uid, owner_gid, follow_symlinks=False)
                if not member.issym():
                    os.chmod(path, member.mode, follow_symlinks=False)
        return verify(archive, stage, expected_digest, expected_tree, verifier_path, owner_uid, owner_gid)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise

def _check_parent_chain(parent, owner_uid):
    for path in reversed([parent, *parent.parents]):
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, owner_uid} or info.st_mode & 0o022:
            raise PromotionError('Unsafe toolchain parent: ' + str(path))


def _rename_noreplace(source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, 'renameat2', None)
    if renameat2 is None:
        raise PromotionError('renameat2(RENAME_NOREPLACE) unavailable')
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(target))

def _remove_created_dirs(created):
    for path, device, inode in reversed(created):
        try:
            info = path.lstat()
            if (info.st_dev, info.st_ino) == (device, inode) and stat.S_ISDIR(info.st_mode):
                path.rmdir()
        except OSError:
            pass

def _make_target_parents(parent, owner_uid):
    missing=[]; current=parent
    while not current.exists() and not current.is_symlink():
        missing.append(current); current=current.parent
    _check_parent_chain(current, owner_uid)
    created=[]
    for path in reversed(missing):
        path.mkdir(mode=0o755)
        info=path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
            raise PromotionError('Unsafe created toolchain parent: '+str(path))
        created.append((path,info.st_dev,info.st_ino))
    _check_parent_chain(parent, owner_uid)
    return created

def _published_result(archive, prepared, target, expected_digest, expected_tree, verifier_path, owner_uid, owner_gid):
    result=verify(archive,target,expected_digest,expected_tree,verifier_path,owner_uid,owner_gid)
    shutil.rmtree(prepared,ignore_errors=True)
    info=target.lstat(); parent_info=target.parent.lstat()
    return result,False,False,info.st_dev,info.st_ino,parent_info.st_dev,parent_info.st_ino

def publish(archive, prepared, target=TARGET, expected_digest=DIGEST, expected_tree=TREE, verifier_path=None, owner_uid=0, owner_gid=0):
    archive,prepared,target=Path(archive),Path(prepared),Path(target)
    parent=target.parent
    _check_parent_chain(parent,owner_uid)
    if target.exists() or target.is_symlink():
        return _published_result(archive,prepared,target,expected_digest,expected_tree,verifier_path,owner_uid,owner_gid)
    result=verify(archive,prepared,expected_digest,expected_tree,verifier_path,owner_uid,owner_gid)
    current=parent
    while not current.exists() and not current.is_symlink(): current=current.parent
    if os.stat(prepared).st_dev != os.stat(current).st_dev:
        raise PromotionError('Prepared compiler root is on another filesystem')
    created=_make_target_parents(parent,owner_uid)
    try:
        _rename_noreplace(prepared,target)
        info=target.lstat(); parent_info=parent.lstat()
        return result,True,bool(created),info.st_dev,info.st_ino,parent_info.st_dev,parent_info.st_ino
    except BaseException:
        _remove_created_dirs(created)
        raise

def publish_from(archive, prepared, target=TARGET, expected_digest=DIGEST, expected_tree=TREE, verifier_path=None, owner_uid=0, owner_gid=0):
    archive,prepared,target=Path(archive),Path(prepared),Path(target)
    parent=target.parent
    _check_parent_chain(parent,owner_uid)
    result=verify(archive,prepared,expected_digest,expected_tree,verifier_path,owner_uid,owner_gid)
    if target.exists() or target.is_symlink():
        existing=_published_result(archive,prepared,target,expected_digest,expected_tree,verifier_path,owner_uid,owner_gid)
        return existing
    created=_make_target_parents(parent,owner_uid)
    destination_stage=None; stage_identity=None
    try:
        destination_stage=Path(tempfile.mkdtemp(prefix='.toolchain-stage-',dir=parent))
        os.chown(destination_stage,owner_uid,owner_gid)
        stage_info=destination_stage.lstat(); stage_identity=(stage_info.st_dev,stage_info.st_ino)
        shutil.rmtree(destination_stage)
        shutil.copytree(prepared,destination_stage,symlinks=True,copy_function=shutil.copy2)
        for root,dirs,files in os.walk(destination_stage,topdown=False,followlinks=False):
            for name in dirs+files:
                path=Path(root)/name
                if not path.is_symlink(): os.chown(path,owner_uid,owner_gid)
        os.chown(destination_stage,owner_uid,owner_gid)
        copied=verify(archive,destination_stage,expected_digest,expected_tree,verifier_path,owner_uid,owner_gid)
        _rename_noreplace(destination_stage,target)
        info=target.lstat(); parent_info=parent.lstat()
        shutil.rmtree(prepared,ignore_errors=True)
        return copied,True,bool(created),info.st_dev,info.st_ino,parent_info.st_dev,parent_info.st_ino
    except BaseException:
        if destination_stage is not None and stage_identity is not None:
            try:
                info=destination_stage.lstat()
                if (info.st_dev,info.st_ino)==stage_identity and stat.S_ISDIR(info.st_mode): shutil.rmtree(destination_stage)
            except OSError:
                pass
        _remove_created_dirs(created)
        raise


def _main():
    if os.geteuid() != 0:
        raise SystemExit('Root authorization required; no changes made.')
    base = Path(__file__).absolute().parent
    archive = base / 'toolchain-rootfs.tar'
    with tempfile.TemporaryDirectory(prefix='oantuti-toolchain-stage-') as temporary:
        stage = Path(temporary) / DIGEST
        prepare(archive, stage)
        result, created, parent_created, target_device, target_inode, parent_device, parent_inode = publish_from(archive, stage, TARGET)
        print(json.dumps({'result': result, 'created': created, 'parentCreated': parent_created, 'targetDevice': target_device, 'targetInode': target_inode, 'parentDevice': parent_device, 'parentInode': parent_inode}))

if __name__ == '__main__':
    _main()
