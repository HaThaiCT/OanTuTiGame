import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('trusted_oci', Path(__file__).parents[1] / 'deploy/linux/trusted-oci-spec.py')
oci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oci)


class TrustedOciSpecTest(unittest.TestCase):
    def test_workload_has_no_host_identity_or_privileges(self):
        value = oci.build_spec()
        process = value['process']
        self.assertNotEqual(process['user']['uid'], 0)
        self.assertNotEqual(process['user']['gid'], 0)
        self.assertTrue(process['noNewPrivileges'])
        self.assertTrue(all(not items for items in process['capabilities'].values()))
        self.assertEqual(process['args'], ['/usr/bin/sleep', '0'])
        self.assertEqual({n['type'] for n in value['linux']['namespaces']}, {'pid', 'network', 'ipc', 'uts', 'mount'})
        self.assertTrue(all('path' not in n for n in value['linux']['namespaces']))

    def test_mounts_are_not_host_binds_and_writable_tmp_is_bounded(self):
        value = oci.build_spec()
        self.assertTrue(value['root']['readonly'])
        self.assertTrue(all(mount['type'] != 'bind' for mount in value['mounts']))
        temporary = next(m for m in value['mounts'] if m['destination'] == '/tmp')
        for option in ['size=16777216', 'nosuid', 'nodev', 'noexec']:
            self.assertIn(option, temporary['options'])

    def test_resource_limits_cannot_be_raised_by_caller(self):
        value = oci.build_spec()
        resources = value['linux']['resources']
        self.assertEqual(resources['memory'], {'limit': 268435456, 'swap': 268435456})
        self.assertEqual(resources['pids']['limit'], 32)
        self.assertEqual(resources['cpu']['quota'], resources['cpu']['period'])
        self.assertEqual(value['process']['rlimits'], [{'type': 'RLIMIT_NOFILE', 'hard': 64, 'soft': 64}])


if __name__ == '__main__':
    unittest.main()
