import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { portableDemoSql, restoreDemo } from '../../../deploy/linux/restore-demo.js';
import { verifyPassword } from '../src/identity/crypto.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'arena-restore-'));
  const demoDataDir = join(root, 'demo');
  mkdirSync(demoDataDir);
  writeFileSync(join(demoDataDir, 'arena_demo.sql.gz'), gzipSync('CREATE TABLE example(id integer);\n'));
  const objects = join(root, 'objects');
  mkdirSync(join(objects, 'storage/replays'), { recursive: true });
  mkdirSync(join(objects, 'storage/submissions'), { recursive: true });
  writeFileSync(join(objects, 'storage/replays/abc.oantuti'), 'replay');
  writeFileSync(join(objects, 'storage/submissions/def.zip'), 'source');
  execFileSync('tar', ['-czf', join(demoDataDir, 'arena_objects.tar.gz'), '-C', objects, 'storage']);
  const psql = join(root, 'psql executable');
  writeFileSync(psql, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--command')) { process.stdout.write(process.env.NONEMPTY === '1' ? '1\\n' : '0\\n'); process.exit(0); }
if (process.env.FAIL_RESTORE === '1') process.exit(19);
fs.copyFileSync(args[args.indexOf('--file') + 1], process.env.SQL_CAPTURE);
`);
  chmodSync(psql, 0o700);
  const env = { ...process.env, PGHOST: 'host; false', PGPORT: '5432', PGUSER: 'restore user', PGDATABASE: 'empty database', PSQL_BIN: psql, SQL_CAPTURE: join(root, 'restored.sql') };
  return { root, demoDataDir, env, clean: () => rmSync(root, { recursive: true, force: true }) };
}

describe('portable host demo restore', () => {
  it('ships only public fixture authority while preserving official demo data', async () => {
    const sql = gunzipSync(readFileSync(new URL('../../../deploy/demo-data/arena_demo.sql.gz', import.meta.url))).toString('utf8');
    const rows = new Map<string, { columns: string[]; values: string[][] }>();
    let current: { columns: string[]; values: string[][] } | undefined;
    for (const line of sql.split('\n')) {
      if (current) {
        if (line === '\\.') current = undefined;
        else current.values.push(line.split('\t'));
        continue;
      }
      const match = /^COPY public\.(\w+) \((.*?)\) FROM stdin;$/.exec(line);
      if (match) {
        current = { columns: match[2].split(', '), values: [] };
        rows.set(match[1], current);
      }
    }
    for (const name of ['sessions', 'password_reset_tokens', 'email_verification_tokens', 'identity_login_attempts', 'outbox_events', 'test_snapshots', 'test_create_attempts', 'command_receipts']) {
      expect(rows.get(name)?.values ?? []).toHaveLength(0);
    }
    expect(rows.get('users')!.values).toHaveLength(126);
    expect(rows.get('teams')!.values).toHaveLength(72);
    expect(rows.get('tournaments')!.values).toHaveLength(46);
    expect(rows.get('replay_objects')!.values).toHaveLength(616);
    const jobs = rows.get('jobs')!;
    const jobIds = new Set(jobs.values.map(row => row[jobs.columns.indexOf('id')]));
    expect(jobs.values.some(row => row[jobs.columns.indexOf('job_type')].startsWith('TEST_'))).toBe(false);
    const attempts = rows.get('job_attempts')!;
    const attemptIds = new Set(attempts.values.map(row => row[attempts.columns.indexOf('id')]));
    for (const row of attempts.values) expect(jobIds.has(row[attempts.columns.indexOf('job_id')])).toBe(true);
    const completions = rows.get('job_completions')!;
    for (const row of completions.values) {
      expect(jobIds.has(row[completions.columns.indexOf('job_id')])).toBe(true);
      expect(attemptIds.has(row[completions.columns.indexOf('attempt_id')])).toBe(true);
    }
    const users = rows.get('users')!;
    const hashes = new Map<string, string>();
    for (const row of users.values) {
      const get = (column: string) => row[users.columns.indexOf(column)];
      expect(get('password_change_required')).toBe('f');
      expect(get('temporary_password_expires_at')).toBe('\\N');
      expect(get('temporary_password_consumed_at')).toBe('\\N');
      expect(get('email')).toBe('\\N');
      hashes.set(get('password_hash'), get('role'));
    }
    for (const [hash, role] of hashes) expect(await verifyPassword(role === 'ADMIN' ? 'DemoAdmin@2026' : 'DemoStudent@2026', hash)).toBe(true);
    for (const row of rows.get('audit_events')!.values) expect(row[rows.get('audit_events')!.columns.indexOf('details')]).toBe('{}');
  });

  it('removes workstation role and client directives without filtering COPY data', () => {
    const sql = '\\restrict oldclient\nALTER TABLE public.example OWNER TO workstation;\nGRANT ALL ON TABLE public.example TO workstation;\nCOPY public.example (text) FROM stdin;\nGRANT data, not SQL\n\\.\n\\unrestrict oldclient\n';
    expect(portableDemoSql(sql)).toBe('COPY public.example (text) FROM stdin;\nGRANT data, not SQL\n\\.\n');
  });

  it('accepts a private password file without publishing its contents', async () => {
    const f = fixture();
    try {
      const password = join(f.root, 'password');
      writeFileSync(password, 'test-only-password\n', { mode: 0o600 });
      await restoreDemo({ cwd: f.root, demoDataDir: f.demoDataDir, env: { ...f.env, PGPASSWORD_FILE: password }, args: ['--fresh-empty-database'] });
      expect(existsSync(f.env.SQL_CAPTURE)).toBe(true);
      expect(readFileSync(f.env.SQL_CAPTURE, 'utf8')).not.toContain('test-only-password');
    } finally { f.clean(); }
  });

  it('requires fresh-empty acknowledgement and explicit database settings before touching objects', async () => {
    const f = fixture();
    try {
      await expect(restoreDemo({ cwd: f.root, demoDataDir: f.demoDataDir, env: f.env, args: [] })).rejects.toThrow('fresh-empty-database');
      await expect(restoreDemo({ cwd: f.root, demoDataDir: f.demoDataDir, env: { ...f.env, PGDATABASE: '' }, args: ['--fresh-empty-database'] })).rejects.toThrow('PGDATABASE');
      expect(existsSync(join(f.root, 'storage'))).toBe(false);
    } finally { f.clean(); }
  });

  it('refuses a nonempty database without extracting evidence', async () => {
    const f = fixture();
    try {
      await expect(restoreDemo({ cwd: f.root, demoDataDir: f.demoDataDir, env: { ...f.env, NONEMPTY: '1' }, args: ['--fresh-empty-database'] })).rejects.toThrow('not empty');
      expect(existsSync(join(f.root, 'storage'))).toBe(false);
      expect(existsSync(f.env.SQL_CAPTURE)).toBe(false);
    } finally { f.clean(); }
  });

  it('restores private evidence into configured roots and rebases database paths without shell parsing', async () => {
    const f = fixture();
    try {
      const replays = join(f.root, "private replay's; directory");
      const sources = join(f.root, 'private sources');
      await restoreDemo({ cwd: f.root, demoDataDir: f.demoDataDir, env: { ...f.env, OANTUTI_REPLAYS_DIR: replays, OANTUTI_SUBMISSION_DIR: sources }, args: ['--fresh-empty-database'] });
      expect(readFileSync(join(replays, 'abc.oantuti'), 'utf8')).toBe('replay');
      expect(readFileSync(join(sources, 'def.zip'), 'utf8')).toBe('source');
      expect(statSync(replays).mode & 0o077).toBe(0);
      expect(statSync(sources).mode & 0o077).toBe(0);
      const sql = readFileSync(f.env.SQL_CAPTURE, 'utf8');
      expect(sql).toContain('CREATE TABLE example');
      expect(sql).toContain('UPDATE public.replay_objects');
      expect(sql).toContain('UPDATE public.submission_sources');
      expect(sql).toContain("private replay''s; directory");
    } finally { f.clean(); }
  });

  it('refuses unrelated files in private roots before applying database changes', async () => {
    const f = fixture();
    try {
      const replays = join(f.root, 'existing');
      mkdirSync(replays, { mode: 0o700 });
      writeFileSync(join(replays, 'unrelated'), 'keep');
      await expect(restoreDemo({ cwd: f.root, demoDataDir: f.demoDataDir, env: { ...f.env, OANTUTI_REPLAYS_DIR: replays }, args: ['--fresh-empty-database'] })).rejects.toThrow('must be empty');
      expect(readFileSync(join(replays, 'unrelated'), 'utf8')).toBe('keep');
      expect(existsSync(f.env.SQL_CAPTURE)).toBe(false);
      expect(existsSync(join(replays, 'abc.oantuti'))).toBe(false);
    } finally { f.clean(); }
  });

  it('rejects archive symlinks before extraction or database apply', async () => {
    const f = fixture();
    try {
      symlinkSync(f.root, join(f.root, 'objects/storage/replays/unsafe'));
      execFileSync('tar', ['-czf', join(f.demoDataDir, 'arena_objects.tar.gz'), '-C', join(f.root, 'objects'), 'storage']);
      await expect(restoreDemo({ cwd: f.root, demoDataDir: f.demoDataDir, env: f.env, args: ['--fresh-empty-database'] })).rejects.toThrow('Invalid demo archive');
      expect(existsSync(f.env.SQL_CAPTURE)).toBe(false);
      expect(existsSync(join(f.root, 'storage/replays/abc.oantuti'))).toBe(false);
    } finally { f.clean(); }
  });

  it('propagates psql failure instead of reporting success', async () => {
    const f = fixture();
    try {
      await expect(restoreDemo({ cwd: f.root, demoDataDir: f.demoDataDir, env: { ...f.env, FAIL_RESTORE: '1' }, args: ['--fresh-empty-database'] })).rejects.toThrow();
      expect(existsSync(f.env.SQL_CAPTURE)).toBe(false);
      expect(existsSync(join(f.root, 'storage/replays/abc.oantuti'))).toBe(false);
      expect(existsSync(join(f.root, 'storage/submissions/def.zip'))).toBe(false);
      await restoreDemo({ cwd: f.root, demoDataDir: f.demoDataDir, env: f.env, args: ['--fresh-empty-database'] });
      expect(readFileSync(join(f.root, 'storage/replays/abc.oantuti'), 'utf8')).toBe('replay');
    } finally { f.clean(); }
  });

  it('refuses public operator-supplied object roots without changing their permissions', async () => {
    const f = fixture();
    try {
      const replays = join(f.root, 'public');
      mkdirSync(replays, { mode: 0o755 });
      chmodSync(replays, 0o755);
      await expect(restoreDemo({ cwd: f.root, demoDataDir: f.demoDataDir, env: { ...f.env, OANTUTI_REPLAYS_DIR: replays }, args: ['--fresh-empty-database'] })).rejects.toThrow('group/world');
      expect(statSync(replays).mode & 0o777).toBe(0o755);
    } finally { f.clean(); }
  });
});
