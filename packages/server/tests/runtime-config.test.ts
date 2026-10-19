import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeGatewayConfig } from '../src/jobs/runtime-config.js';

describe('operator native execution configuration', () => {
  it('rejects writable config, duplicate languages and native/dev coexistence', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-config-'));
    try {
      const file = join(root, 'native.json');
      const toolchains = ['PYTHON', 'TYPESCRIPT', 'CPP'].map(language => ({ language, imageDigest: 'a'.repeat(64), version: 'pinned', flags: [] }));
      const config = { executable: '/opt/arena/broker', socketPath: '/run/arena/jobs.sock', workerUid: 1001, socketGid: 1001,
        deploymentGeneration: 2, runtimeProfileDigest: 'b'.repeat(64), maxBuildSlots: 2, maxGameSlots: 4,
        spoolRoot: '/var/lib/arena/spool', compiledArtifactsDir: '/var/lib/arena/compiled', toolchains };
      writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
      expect(nativeGatewayConfig({ OANTUTI_NATIVE_CONFIG: file })?.deploymentGeneration).toBe(2);
      expect(() => nativeGatewayConfig({ OANTUTI_NATIVE_CONFIG: file, OANTUTI_DEV_EXECUTION: '1' })).toThrow('mutually exclusive');
      writeFileSync(file, JSON.stringify({ ...config, toolchains: [toolchains[0], toolchains[0], toolchains[2]] }));
      expect(() => nativeGatewayConfig({ OANTUTI_NATIVE_CONFIG: file })).toThrow('duplicate');
      chmodSync(file, 0o666);
      expect(() => nativeGatewayConfig({ OANTUTI_NATIVE_CONFIG: file })).toThrow('not group/world writable');
      expect(() => nativeGatewayConfig({ OANTUTI_NATIVE_CONFIG: 'relative.json' })).toThrow('absolute');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
