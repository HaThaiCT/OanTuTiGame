import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rootfs_verifier', Path(__file__).parents[1] / 'deploy/linux/verify-rootfs.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
promotion_spec = importlib.util.spec_from_file_location('toolchain_promoter', Path(__file__).parents[1] / 'deploy/linux/promote-toolchain-rootfs.py')
promoter = importlib.util.module_from_spec(promotion_spec)
promotion_spec.loader.exec_module(promoter)


class NativeWorkerRootSeparationTest(unittest.TestCase):
    def test_worker_uses_separate_pinned_toolchain_rootfs(self):
        installer = (Path(__file__).parents[1] / 'deploy/linux/operator-commission-worker.sh').read_text()
        toolchain = '626e4e3c7f82a95dfec96954b6909543ef38159833b0ae9a061ce71100de0730'
        game_runtime = 'fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb'
        self.assertIn('/var/lib/oantuti/development/toolchains/' + toolchain, installer)
        self.assertIn('"rootfs":"$toolchain_rootfs","imageDigest":"' + toolchain + '"', installer)
        self.assertIn('--runtime-rootfs /var/lib/oantuti/development/rootfs/' + game_runtime, installer)
        self.assertIn('g++ -std=c++20 -x c++ -fsyntax-only', installer)



class ToolchainPromotionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path.home())
        self.base = Path(self.temp.name)
        self.archive = self.base / 'toolchain.tar'
        with tarfile.open(self.archive, 'w') as archive:
            item = tarfile.TarInfo('probe')
            item.mode = 0o755
            item.size = 2
            archive.addfile(item, io.BytesIO(b'OK'))
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.stage = self.base / 'prepared'
        self.target = self.base / 'toolchains' / self.digest
        self.tree = 'fb2cef96cfe10e6115ef7074c31d72647c96b2283aa2c5f95e0aefb8a674685d'

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self):
        return promoter.prepare(self.archive, self.stage, self.digest, self.tree, owner_uid=os.getuid(), owner_gid=os.getgid())
    def publish(self):
        return promoter.publish_from(self.archive, self.stage, self.target, self.digest, self.tree, owner_uid=os.getuid(), owner_gid=os.getgid())[:3]

    def test_promotes_verified_tree_and_reuses_only_exact_existing_target(self):
        result = self.prepare()
        published, created, parent_created = self.publish()
        self.assertTrue(created)
        self.assertTrue(parent_created)
        self.assertEqual(published, result)
        self.assertEqual((self.target / 'probe').read_bytes(), b'OK')
        second_stage = self.base / 'prepared-again'
        promoter.prepare(self.archive, second_stage, self.digest, self.tree, owner_uid=os.getuid(), owner_gid=os.getgid())
        reused, created, parent_created = promoter.publish_from(self.archive, second_stage, self.target, self.digest, self.tree, owner_uid=os.getuid(), owner_gid=os.getgid())[:3]
        self.assertFalse(created)
        self.assertFalse(parent_created)
        self.assertEqual(reused, result)

    def test_refuses_symlinked_parent_without_side_effect(self):
        unsafe = self.base / 'unsafe'
        unsafe.symlink_to(self.base, target_is_directory=True)
        target = unsafe / 'toolchains' / self.digest
        with self.assertRaises(promoter.PromotionError):
            promoter.publish(self.archive, self.stage, target, self.digest, self.tree, owner_uid=os.getuid(), owner_gid=os.getgid())
        self.assertFalse((self.base / 'toolchains').exists())

    def test_refuses_preexisting_unverified_target_without_replacement(self):
        self.target.parent.mkdir()
        self.target.mkdir()
        marker = self.target / 'marker'
        marker.write_text('keep')
        with self.assertRaises(Exception):
            promoter.publish(self.archive, self.stage, self.target, self.digest, self.tree, owner_uid=os.getuid(), owner_gid=os.getgid())
        self.assertEqual(marker.read_text(), 'keep')

    def test_atomic_publish_never_replaces_concurrent_target(self):
        source = self.base / 'source'
        source.mkdir()
        (source / 'ours').write_text('ours')
        target = self.base / 'existing'
        target.mkdir()
        (target / 'theirs').write_text('theirs')
        with self.assertRaises(FileExistsError):
            promoter._rename_noreplace(source, target)
        self.assertEqual((target / 'theirs').read_text(), 'theirs')
        self.assertEqual((source / 'ours').read_text(), 'ours')

    def test_invalid_prepared_tree_does_not_create_target_ancestors(self):
        self.stage.mkdir()
        (self.stage / 'unexpected').write_text('not an archive member')
        with self.assertRaises(Exception):
            promoter.publish(self.archive, self.stage, self.target, self.digest, self.tree, owner_uid=os.getuid(), owner_gid=os.getgid())
        self.assertFalse(self.target.parent.exists())


    def test_target_race_cleans_only_newly_created_parent_chain(self):
        self.prepare()
        original = promoter._rename_noreplace

        def race(source, target):
            target.mkdir()
            (target / 'concurrent').write_text('keep')
            original(source, target)

        promoter._rename_noreplace = race
        try:
            with self.assertRaises(FileExistsError):
                self.publish()
        finally:
            promoter._rename_noreplace = original
        self.assertEqual((self.target / 'concurrent').read_text(), 'keep')



    def test_cross_device_stage_is_rejected_before_target_parent_creation(self):
        self.prepare()
        real_stat = os.stat

        def different_device(path, *args, **kwargs):
            result = real_stat(path, *args, **kwargs)
            values = tuple(result)
            return os.stat_result((result.st_dev + (1 if Path(path) == self.stage else 0), *values[1:]))

        with patch.object(promoter, '_rename_noreplace', side_effect=AssertionError('rename must not run')):
            with patch.object(promoter.os, 'stat', side_effect=different_device):
                with self.assertRaises(promoter.PromotionError):
                    promoter.publish(self.archive, self.stage, self.target, self.digest, self.tree, owner_uid=os.getuid(), owner_gid=os.getgid())
        self.assertFalse(self.target.parent.exists())
    def test_publish_cleanup_never_removes_replaced_parent(self):
        self.prepare()
        original = promoter._rename_noreplace
        moved = self.base / 'moved-toolchains'

        def replace_parent(source, target):
            target.parent.rename(moved)
            target.parent.mkdir()
            raise OSError('injected rename failure')

        promoter._rename_noreplace = replace_parent
        try:
            with self.assertRaises(OSError):
                promoter.publish_from(self.archive, self.stage, self.target, self.digest, self.tree, owner_uid=os.getuid(), owner_gid=os.getgid())
        finally:
            promoter._rename_noreplace = original
        self.assertTrue(self.target.parent.exists())
class RootfsVerificationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path.home())
        self.base = Path(self.temp.name)
        self.root = self.base / 'rootfs'
        self.root.mkdir(mode=0o755)
        self.root.chmod(0o755)
        (self.root / 'file').write_bytes(b'original')
        (self.root / 'file').chmod(0o644)
        self.archive = self.base / 'rootfs.tar'
        with tarfile.open(self.archive, 'w') as archive:
            item = tarfile.TarInfo('file')
            item.mode = 0o644
            item.size = 8
            archive.addfile(item, io.BytesIO(b'original'))
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def tearDown(self):
        self.temp.cleanup()

    def check(self):
        return verifier.verify(self.archive, self.root, self.digest, os.getuid(), os.getgid())

    def test_complete_tree_has_stable_digest(self):
        first = self.check()
        self.assertEqual(first['memberCount'], 1)
        self.assertEqual(first['normalizedTreeSha256'], self.check()['normalizedTreeSha256'])
        self.assertEqual(first['archiveSha256'], self.digest)

    def test_changed_file_rejected(self):
        (self.root / 'file').write_bytes(b'tampered')
        with self.assertRaises(verifier.VerificationError):
            self.check()

    def test_writable_mode_rejected(self):
        (self.root / 'file').chmod(0o666)
        with self.assertRaises(verifier.VerificationError):
            self.check()

    def test_extra_file_rejected(self):
        (self.root / 'extra').write_text('unexpected')
        with self.assertRaises(verifier.VerificationError):
            self.check()

    def test_invalid_digest_rejected(self):
        with self.assertRaises(verifier.VerificationError):
            verifier.verify(self.archive, self.root, 'not-a-digest')

    def test_traversal_path_rejected(self):
        with self.assertRaises(verifier.VerificationError):
            verifier.canonical_path('../outside')

    def test_required_runtime_executable_symlinks_are_verified(self):
        (self.root / 'file').unlink()
        paths = ['usr', 'usr/bin', 'opt', 'opt/node', 'opt/node/bin']
        for path in paths:
            (self.root / path).mkdir(parents=True, exist_ok=True)
            (self.root / path).chmod(0o755)
        aliases = {
            'usr/bin/python3': 'python3.12',
            'usr/bin/node': '../../opt/node/bin/node',
            'usr/bin/g++': 'g++-13',
        }
        executables = {
            'usr/bin/python3.12': b'#!/bin/sh\n',
            'opt/node/bin/node': b'#!/bin/sh\n',
            'usr/bin/g++-13': b'#!/bin/sh\n',
        }
        for target, content in executables.items():
            path = self.root / target
            path.write_bytes(content)
            path.chmod(0o755)
        for name, target in aliases.items():
            (self.root / name).symlink_to(target)
        self.archive.unlink()
        with tarfile.open(self.archive, 'w') as archive:
            for path in paths:
                directory = tarfile.TarInfo(path)
                directory.type = tarfile.DIRTYPE
                directory.mode = 0o755
                archive.addfile(directory)
            for name, content in executables.items():
                item = tarfile.TarInfo(name)
                item.mode = 0o755
                item.size = len(content)
                archive.addfile(item, io.BytesIO(content))
            for name, target in aliases.items():
                alias = tarfile.TarInfo(name)
                alias.type = tarfile.SYMTYPE
                alias.linkname = target
                archive.addfile(alias)
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        result = verifier.verify(self.archive, self.root, self.digest, os.getuid(), os.getgid(),
                                 required_executables=aliases)
        self.assertEqual(result['memberCount'], len(paths) + len(executables) + len(aliases))

    def test_required_executable_rejects_missing_path(self):
        with self.assertRaises(verifier.VerificationError):
            verifier.verify(self.archive, self.root, self.digest, os.getuid(), os.getgid(),
                            required_executables={'usr/bin/missing': 'missing'})

    def test_required_executable_rejects_absolute_link_target(self):
        (self.root / 'file-alias').symlink_to('/bin/sh')
        with self.assertRaises(verifier.VerificationError):
            verifier.verify(self.archive, self.root, self.digest, os.getuid(), os.getgid(),
                            required_executables={'file-alias': '/bin/sh'})

    def test_archive_replacement_cannot_validate_unhashed_contents(self):
        replacement = self.base / 'replacement.tar'
        with tarfile.open(replacement, 'w') as archive:
            item = tarfile.TarInfo('file')
            item.mode = 0o644
            item.size = 8
            archive.addfile(item, io.BytesIO(b'tampered'))
        (self.root / 'file').write_bytes(b'tampered')
        original_digest = verifier.digest
        swapped = False

        def replace_after_hash(stream):
            nonlocal swapped
            result = original_digest(stream)
            if not swapped:
                swapped = True
                os.replace(replacement, self.archive)
            return result

        with patch.object(verifier, 'digest', side_effect=replace_after_hash):
            with self.assertRaisesRegex(verifier.VerificationError, 'CONTENT_MISMATCH'):
                self.check()


if __name__ == '__main__':
    unittest.main()
