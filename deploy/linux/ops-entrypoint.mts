import { spawnSync } from 'node:child_process';
import { stageOperatorSecrets } from './operator-secrets.mts';

const ALLOWED_OPERATOR_CLIS: Readonly<Record<string,true>> = {
  'deploy/linux/apply-migrations.mts': true,
  'deploy/linux/bootstrap-admin.mts': true,
  'deploy/linux/recover-admin.mts': true,
  'deploy/linux/online-preflight.mts': true,
};
const args = process.argv.slice(2);
if (!args.length || !Object.hasOwn(ALLOWED_OPERATOR_CLIS,args[0]!)) throw new Error('Unsupported operator CLI path');
if (process.env.PGPASSWORD) throw new Error('Password environment is forbidden; use PGPASSWORD_FILE');
const cleanup = stageOperatorSecrets();
try {
  const child = spawnSync(process.execPath, ['--import', 'tsx', ...args], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  if (child.error) throw new Error('Failed to run operator CLI');
  process.exitCode = child.status ?? 1;
} finally {
  cleanup();
}
