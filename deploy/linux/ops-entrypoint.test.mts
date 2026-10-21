import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stageOperatorSecrets } from './operator-secrets.mts';

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('operator CLI secret handoff', () => {
  it('stages mounted secrets into mode-0600 copies and removes them on cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'oantuti-ops-test-')); fixtures.push(root);
    const pgFile = join(root, 'pgpass'); const smtpFile = join(root, 'smtp'); const keyringFile = join(root, 'keyring.json');
    writeFileSync(pgFile, 'db-secret', { mode: 0o644 }); writeFileSync(smtpFile, 'smtp-secret\n', { mode: 0o640 });
    writeFileSync(keyringFile, '{"currentKeyId":"k","keys":{"k":"redacted"}}', { mode: 0o640 });
    const env = { PGPASSWORD_FILE:pgFile, OANTUTI_SMTP_PASSWORD_FILE:smtpFile, OANTUTI_MAIL_KEYRING_FILE:keyringFile };
    const cleanup = stageOperatorSecrets(env);
    const staged = { pg:env.PGPASSWORD_FILE!, smtp:env.OANTUTI_SMTP_PASSWORD_FILE!, keyring:env.OANTUTI_MAIL_KEYRING_FILE! };
    try {
      const expected = { pg:'db-secret', smtp:'smtp-secret\n', keyring:'{"currentKeyId":"k","keys":{"k":"redacted"}}' };
      for (const [name,path] of Object.entries(staged)) {
        expect(readFileSync(path,'utf8')).toBe(expected[name as keyof typeof expected]);
        expect(statSync(path).mode&0o777).toBe(0o600);
        expect(statSync(path).uid).toBe(process.getuid?.());
        expect(path).not.toBe(({pg:pgFile,smtp:smtpFile,keyring:keyringFile} as const)[name as 'pg'|'smtp'|'keyring']);
      }
    } finally { cleanup(); }
    for (const path of Object.values(staged)) expect(existsSync(path)).toBe(false);
  });
  it('rejects Node eval arguments rather than running arbitrary code in the owner-role container', () => {
    const root = mkdtempSync(join(tmpdir(), 'oantuti-ops-eval-')); fixtures.push(root);
    const marker = join(root, 'marker');
    const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`;
    const child = spawnSync(process.execPath, ['--import','tsx','deploy/linux/ops-entrypoint.mts','-e',code], { cwd:process.cwd(), encoding:'utf8', env:{...process.env,PGHOST:'postgres'} });
    expect(child.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });


  it('refuses symlinked mounted secret files without running the CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'oantuti-ops-link-')); fixtures.push(root);
    const secret = join(root, 'secret'); const link = join(root, 'secret-link');
    writeFileSync(secret, 'do-not-follow'); symlinkSync(secret, link);
    const child = spawnSync(process.execPath, ['--import','tsx','deploy/linux/ops-entrypoint.mts','deploy/linux/online-preflight.mts'], { cwd:process.cwd(), encoding:'utf8', env:{...process.env,PGHOST:'postgres',PGPASSWORD_FILE:link} });
    expect(child.status).not.toBe(0);
    expect(child.stdout+child.stderr).toContain('Invalid PGPASSWORD_FILE');
    expect(child.stdout+child.stderr).not.toContain('do-not-follow');
  });
});
