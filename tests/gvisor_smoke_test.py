import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile
import subprocess

spec = importlib.util.spec_from_file_location('gvisor_smoke', Path(__file__).parents[1] / 'deploy/linux/smoke-gvisor.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class FixedGvisorCommandTest(unittest.TestCase):
    def test_launch_denies_network_and_overlay_and_requires_sidecars(self):
        command = smoke.runsc_command(Path('/root-owned/state'), 'trusted-id', Path('/root-owned/bundle'))
        for flag in ['--network=none', '--overlay2=none', '--host-uds=none', '--host-fifo=none', '--sidecar-usage-policy=STRICT', '--sidecar-release-enforcement-policy=ALWAYS']:
            self.assertIn(flag, command)
        self.assertNotIn('--ignore-cgroups', command)
        self.assertNotIn('--rootless', command)
        self.assertEqual(command[-3:], ['run', '--bundle=/root-owned/bundle', 'trusted-id'])

    def test_delete_cannot_change_action_or_pass_extra_workload_arguments(self):
        command = smoke.runsc_command(Path('/root-owned/state'), 'trusted-id')
        self.assertEqual(command[-3:], ['delete', '--force', 'trusted-id'])

    def test_root_owned_but_changed_generator_is_not_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'generator.py'
            path.write_text('changed')
            with patch.object(smoke, 'trusted'):
                with self.assertRaisesRegex(RuntimeError, 'integrity mismatch'):
                    smoke.verify_file(path, smoke.SPEC_HASH)

    def test_missing_unit_is_only_accepted_when_kernel_cgroup_is_absent(self):
        failed = subprocess.CompletedProcess([], 5)
        with patch.object(smoke.subprocess, 'run', return_value=failed), patch.object(Path, 'exists', return_value=False):
            smoke.stop_and_confirm('trusted-fixture.service')
        with patch.object(smoke.subprocess, 'run', return_value=failed), patch.object(Path, 'exists', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'cgroup still present'):
                smoke.stop_and_confirm('trusted-fixture.service')

    def test_empty_metadata_does_not_hide_populated_kernel_cgroup(self):
        success = subprocess.CompletedProcess([], 0)
        with patch.object(smoke.subprocess, 'run', return_value=success), patch.object(Path, 'exists', return_value=True), patch.object(Path, 'read_text', return_value='populated 1\nfrozen 0\n'):
            with self.assertRaisesRegex(RuntimeError, 'descendants remain'):
                smoke.stop_and_confirm('trusted-fixture.service')



if __name__ == '__main__':
    unittest.main()
