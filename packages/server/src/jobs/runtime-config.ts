import { readSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { BuildToolchain } from '@oantuti/protocol';
import type { LocalJobBrokerOptions } from './local-transport.js';

/** Operator-owned configuration, never supplied by an HTTP caller. */
export function nativeGatewayConfig(env: NodeJS.ProcessEnv = process.env): LocalJobBrokerOptions | undefined {
  const filename = env.OANTUTI_NATIVE_CONFIG;
  if (!filename) return undefined;
  if (env.OANTUTI_DEV_EXECUTION === '1') throw new Error('Native execution and the development executor are mutually exclusive');
  if (!isAbsolute(filename)) throw new Error('OANTUTI_NATIVE_CONFIG must be an absolute path');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o022) !== 0
      || (stat.uid !== 0 && stat.uid !== process.getuid?.())) {
      throw new Error('Native configuration must be a bounded regular file, not group/world writable, owned by the operator');
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('Native configuration changed while reading');
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Native configuration changed while reading');
    value = JSON.parse(bytes.toString('utf8'));
  } finally { closeSync(fd); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native configuration');
  const input = value as Record<string, unknown>;
  const absolute = (key: string): string => {
    const item = input[key];
    if (typeof item !== 'string' || !isAbsolute(item) || item.includes('\0')) throw new Error(`Invalid native ${key}`);
    return item;
  };
  const integer = (key: string, minimum: number): number => {
    const item = input[key];
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < minimum) throw new Error(`Invalid native ${key}`);
    return item;
  };
  const digest = input.runtimeProfileDigest;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid native runtimeProfileDigest');
  if (!Array.isArray(input.toolchains) || input.toolchains.length !== 3) throw new Error('Three native toolchains are required');
  const seen = new Set<string>();
  const toolchains: BuildToolchain[] = input.toolchains.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid native toolchain');
    const toolchain = item as Record<string, unknown>;
    const language = toolchain.language;
    if ((language !== 'PYTHON' && language !== 'TYPESCRIPT' && language !== 'CPP') || seen.has(language)) throw new Error('Invalid or duplicate native language');
    seen.add(language);
    if (typeof toolchain.imageDigest !== 'string' || !/^[a-f0-9]{64}$/.test(toolchain.imageDigest)
      || typeof toolchain.version !== 'string' || !toolchain.version.trim()
      || !Array.isArray(toolchain.flags) || !toolchain.flags.every((flag: unknown) => typeof flag === 'string')) throw new Error('Invalid native toolchain identity');
    return { language, imageDigest: toolchain.imageDigest, version: toolchain.version, flags: toolchain.flags };
  });
  return {
    executable: absolute('executable'), socketPath: absolute('socketPath'), workerUid: integer('workerUid', 1),
    socketGid: integer('socketGid', 0), deploymentGeneration: integer('deploymentGeneration', 1),
    runtimeProfileDigest: digest, maxBuildSlots: integer('maxBuildSlots', 1), maxGameSlots: integer('maxGameSlots', 1),
    spoolRoot: absolute('spoolRoot'), compiledArtifactsDir: absolute('compiledArtifactsDir'),
    ...(input.completionRoot === undefined ? {} : { completionRoot: absolute('completionRoot') }), toolchains,
  };
}
