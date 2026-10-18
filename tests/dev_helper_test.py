import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile
import json

spec = importlib.util.spec_from_file_location('dev_helper', Path(__file__).parents[1] / 'deploy/linux/oantuti-dev-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class DevHelperTest(unittest.TestCase):
    def test_arbitrary_commands_and_options_are_denied(self):
        for action in ['bash', 'runsc', 'smoke-controller --root /', '../verify-rootfs', 'install']:
            with self.assertRaisesRegex(ValueError, 'ACTION_DENIED'):
                helper.command(action)

    def test_actions_have_no_shell_or_caller_paths(self):
        for action in ['verify-rootfs', 'smoke-controller', 'smoke-reaper']:
            command = helper.command(action)
            self.assertEqual(command[:2], ['/usr/bin/python3', '-I'])
            self.assertTrue(command[2].startswith(str(helper.BUNDLE) + '/'))

    def test_extra_arguments_fail_before_subprocess_execution(self):
        with patch.object(helper.sys, 'argv', ['helper', 'verify-rootfs', '/etc/shadow']), patch.object(helper.subprocess, 'run') as run:
            self.assertEqual(helper.main(), 1)
            run.assert_not_called()


    def test_tampered_bundle_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory)
            names = ['verify-rootfs.py', 'smoke-cgroup-kernel.py', 'controller', 'reaper']
            (bundle / 'manifest.json').write_text(json.dumps({name: '0' * 64 for name in names}))
            for name in names:
                (bundle / name).write_text('tampered payload')
            with patch.object(helper, 'BUNDLE', bundle), patch.object(helper, 'trusted'), patch.object(helper.os, 'geteuid', return_value=0), patch.object(helper.sys, 'argv', ['helper', 'smoke-controller']), patch.object(helper.subprocess, 'run') as run:
                self.assertEqual(helper.main(), 1)
                run.assert_not_called()

if __name__ == '__main__':
    unittest.main()
