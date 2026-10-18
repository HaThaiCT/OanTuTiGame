import errno
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('kernel_smoke', Path(__file__).parents[1] / 'deploy/linux/smoke-cgroup-kernel.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class KernelSmokeStateTest(unittest.TestCase):
    def test_removed_cgroup_is_not_empty_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                smoke.wait_state(Path(directory), 'populated', '0', timeout=0)

    def test_offline_cgroup_error_is_not_empty_confirmation(self):
        with patch.object(Path, 'read_text', side_effect=OSError(errno.ENODEV, 'No such device')):
            with self.assertRaises(OSError) as caught:
                smoke.wait_state(Path('/unused'), 'populated', '0', timeout=0)
            self.assertEqual(caught.exception.errno, errno.ENODEV)

    def test_remaining_descendants_time_out(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'cgroup.events').write_text('populated 1\nfrozen 0\n')
            with self.assertRaisesRegex(RuntimeError, 'transition timeout'):
                smoke.wait_state(path, 'populated', '0', timeout=0)

    def test_explicit_empty_state_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'cgroup.events').write_text('populated 0\nfrozen 0\n')
            smoke.wait_state(path, 'populated', '0', timeout=0)


if __name__ == '__main__':
    unittest.main()
