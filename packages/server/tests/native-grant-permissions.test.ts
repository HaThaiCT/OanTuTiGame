import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, chmod, symlink, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { nativeGatewayConfig } from '../src/jobs/runtime-config.js';
import { createAttemptDirectory, writeGrant } from '../src/jobs/native-assignment.js';

describe('native grant permissions and grantGid transport seam', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'grant-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('runtime-config nativeGatewayConfig', () => {
    it('parses valid grantGid when API process is a member', () => {
      const myGid = process.getgid?.() ?? 0;
      const configFile = path.join(tempDir, 'native-config.json');
      const validConfig = {
        executable: '/bin/true',
        socketPath: path.join(tempDir, 'broker.sock'),
        workerUid: 997,
        socketGid: myGid,
        grantGid: myGid,
        deploymentGeneration: 1,
        runtimeProfileDigest: 'a'.repeat(64),
        maxBuildSlots: 1,
        maxGameSlots: 1,
        spoolRoot: path.join(tempDir, 'spool'),
        compiledArtifactsDir: path.join(tempDir, 'artifacts'),
        toolchains: [
          { language: 'PYTHON', imageDigest: 'b'.repeat(64), version: '3.12', flags: [] },
          { language: 'TYPESCRIPT', imageDigest: 'c'.repeat(64), version: '5.6', flags: [] },
          { language: 'CPP', imageDigest: 'd'.repeat(64), version: '13', flags: [] }
        ]
      };
      writeFileSync(configFile, JSON.stringify(validConfig), { mode: 0o600 });
      const opts = nativeGatewayConfig({ OANTUTI_NATIVE_CONFIG: configFile });
      expect(opts?.grantGid).toBe(myGid);
    });

    it('fails closed when API process is not a member of grantGid', () => {
      const unassignedGid = 65432; // unlikely to belong to current process
      const configFile = path.join(tempDir, 'native-config-invalid-gid.json');
      const invalidConfig = {
        executable: '/bin/true',
        socketPath: path.join(tempDir, 'broker.sock'),
        workerUid: 997,
        socketGid: process.getgid?.() ?? 0,
        grantGid: unassignedGid,
        deploymentGeneration: 1,
        runtimeProfileDigest: 'a'.repeat(64),
        maxBuildSlots: 1,
        maxGameSlots: 1,
        spoolRoot: path.join(tempDir, 'spool'),
        compiledArtifactsDir: path.join(tempDir, 'artifacts'),
        toolchains: [
          { language: 'PYTHON', imageDigest: 'b'.repeat(64), version: '3.12', flags: [] },
          { language: 'TYPESCRIPT', imageDigest: 'c'.repeat(64), version: '5.6', flags: [] },
          { language: 'CPP', imageDigest: 'd'.repeat(64), version: '13', flags: [] }
        ]
      };
      writeFileSync(configFile, JSON.stringify(invalidConfig), { mode: 0o600 });
      expect(() => nativeGatewayConfig({ OANTUTI_NATIVE_CONFIG: configFile })).toThrow(/not a member of grantGid/);
    });

    it('fails closed when grantGid is missing from config', () => {
      const configFile = path.join(tempDir, 'native-config-no-gid.json');
      const noGidConfig = {
        executable: '/bin/true',
        socketPath: path.join(tempDir, 'broker.sock'),
        workerUid: 997,
        socketGid: process.getgid?.() ?? 0,
        deploymentGeneration: 1,
        runtimeProfileDigest: 'a'.repeat(64),
        maxBuildSlots: 1,
        maxGameSlots: 1,
        spoolRoot: path.join(tempDir, 'spool'),
        compiledArtifactsDir: path.join(tempDir, 'artifacts'),
        toolchains: [
          { language: 'PYTHON', imageDigest: 'b'.repeat(64), version: '3.12', flags: [] },
          { language: 'TYPESCRIPT', imageDigest: 'c'.repeat(64), version: '5.6', flags: [] },
          { language: 'CPP', imageDigest: 'd'.repeat(64), version: '13', flags: [] }
        ]
      };
      writeFileSync(configFile, JSON.stringify(noGidConfig), { mode: 0o600 });
      expect(() => nativeGatewayConfig({ OANTUTI_NATIVE_CONFIG: configFile })).toThrow(/Invalid native grantGid/);
    });
  });

  describe('attempt directory and grant file permissions', () => {
    it('rejects symlink spool without changing the target', async () => {
      const target = path.join(tempDir, 'target');
      await mkdir(target, { mode: 0o700 });
      const link = path.join(tempDir, 'link');
      await symlink(target, link);
      await expect(createAttemptDirectory(link, 'attempt', process.getgid?.() ?? 0)).rejects.toThrow(/spool/i);
      expect((await stat(target)).mode & 0o777).toBe(0o700);
      expect(await readdir(target)).toEqual([]);
    });

    it('rejects group writable existing spool before changing it', async () => {
      await chmod(tempDir, 0o770);
      await expect(createAttemptDirectory(tempDir, 'attempt', process.getgid?.() ?? 0)).rejects.toThrow(/spool/i);
      expect((await stat(tempDir)).mode & 0o777).toBe(0o770);
      expect(await readdir(tempDir)).toEqual([]);
    });

    it('rejects nonmember grant group before creating a spool', async () => {
      const spool = path.join(tempDir, 'spool');
      await expect(createAttemptDirectory(spool, 'attempt', 65432)).rejects.toThrow(/grant|group/i);
      await expect(stat(spool)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('creates attempt directory with 0750 mode and assigned grantGid when configured', async () => {
      const myGid = process.getgid?.() ?? 0;
      const attemptDir = await createAttemptDirectory(tempDir, '00000000-0000-0000-0000-000000000001', myGid);
      const st = await stat(attemptDir);
      // Mode should be 0750 (octal 0o40750 for dir)
      const permissions = st.mode & 0o777;
      expect(permissions).toBe(0o750);
      expect(st.gid).toBe(myGid);
      expect(permissions & 0o020).toBe(0); // No group write
      expect(permissions & 0o050).toBe(0o050); // Group read + exec
      expect(permissions & 0o007).toBe(0); // Zero other access
    });

    it('sets 0710 mode on parent spool root with assigned grantGid', async () => {
      const myGid = process.getgid?.() ?? 0;
      const spoolParent = path.join(tempDir, 'test-spool-parent');
      await createAttemptDirectory(spoolParent, '00000000-0000-0000-0000-000000000002', myGid);
      const st = await stat(spoolParent);
      const permissions = st.mode & 0o777;
      expect(permissions).toBe(0o710);
      expect(st.gid).toBe(myGid);
    });

    it('writes grant file with 0640 mode and assigned grantGid when configured', async () => {
      const myGid = process.getgid?.() ?? 0;
      const attemptDir = await createAttemptDirectory(tempDir, '00000000-0000-0000-0000-000000000003', myGid);
      const grant = await writeGrant(attemptDir, 'test-grant.bin', Buffer.from('payload-bytes'), myGid);
      const st = await stat(grant.path);
      const permissions = st.mode & 0o777;
      expect(permissions).toBe(0o640);
      expect(st.gid).toBe(myGid);
      expect(permissions & 0o040).toBe(0o040); // Group read
      expect(permissions & 0o030).toBe(0); // No group write or exec
      expect(permissions & 0o007).toBe(0); // Zero other access
    });

    it('writes internal completion capsules with default 0600 mode without grantGid broadening', async () => {
      const myGid = process.getgid?.() ?? 0;
      const attemptDir = await createAttemptDirectory(tempDir, '00000000-0000-0000-0000-000000000004', myGid);
      // Internal completion capsules do not pass grantGid
      const completion = await writeGrant(attemptDir, 'completion.json', Buffer.from('capsule-bytes'));
      const st = await stat(completion.path);
      const permissions = st.mode & 0o777;
      expect(permissions).toBe(0o600);
      // Group has zero read, write, or execute access
      expect(permissions & 0o070).toBe(0);
    });
  });
});
