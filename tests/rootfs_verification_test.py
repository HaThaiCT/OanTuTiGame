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
        # Test fixtures have developer ownership; CLI never accepts this override.
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
