/**
 * Durable, digest-addressed store for compiled build outputs.
 *
 * A BUILD produces one artifact that a later GAME ships instead of recompiling, so the bytes need
 * a home that outlives the build attempt (05 §64: the toolchain is part of the build identity). The
 * store keeps two things:
 *
 *   - `objects/<digest>.bin`  the exact bytes, addressed by their own SHA-256, and
 *   - `keys/<sha256(key)>.json`  the record that maps a deterministic build-cache key
 *     `compiled/<language>/<sourceDigest>/<toolchainDigest>` to that content.
 *
 * The key is a pure function of the intake manifest digest and the operator's toolchain identity,
 * so a GAME assignment can resolve exactly the artifact a build produced without trusting any path
 * or key the worker supplies. `storedAt`/`entrypoint` live only in the record; the bytes are
 * content-addressed, so two builds that produce identical output share one object.
 *
 * Durability follows the source store's rules: a write lands in a private temp file, is fsynced,
 * renamed into place and the parent directory is fsynced, so a crash leaves either the previous
 * object or the new one. Every read re-hashes the bytes and compares digest and length: an object
 * whose bytes do not match its record is reported as missing, never handed to a match.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';
import type { BotLanguage, BuildToolchain, CompiledArtifact, Digest } from '@oantuti/protocol';
import { assertPrivateObjectRoot } from '../persistence/private-root.js';

/** Ceiling for one compiled output. The gateway stages it over bounded frames. */
export const MAX_COMPILED_BYTES = 8 * 1024 * 1024;

export const LANGUAGES: readonly BotLanguage[] = ['PYTHON', 'TYPESCRIPT', 'CPP'];

export class CompiledArtifactError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CompiledArtifactError';
  }
}

export function sha256Hex(bytes: Buffer | string): Digest {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Build-cache identity of one toolchain. The preimage is canonical JSON-free by design: every field
 * on its own line, one trailing newline (`language\nimageDigest\nversion\n<flag>\n…`), so a sandbox
 * worker and the control plane derive the same digest without sharing a serializer.
 */
export function toolchainDigest(toolchain: BuildToolchain): Digest {
  return sha256Hex(
    [toolchain.language, toolchain.imageDigest, toolchain.version, ...toolchain.flags].join('\n') + '\n'
  );
}

/** Deterministic key of the artifact one `(language, source manifest, toolchain)` build produces. */
export function compiledArtifactKey(
  language: BotLanguage,
  sourceDigest: Digest,
  toolchain: BuildToolchain
): string {
  return ['compiled', language, sourceDigest, toolchainDigest(toolchain)].join('/');
}

/** The durable record of one compiled artifact; `key`/`digest`/`sizeBytes`/`entrypoint` are the contract. */
export interface CompiledArtifactRecord extends CompiledArtifact {
  readonly language: BotLanguage;
  /** Manifest digest of the source this artifact was built from (`BuildAssignment.manifestDigest`). */
  readonly sourceDigest: Digest;
  readonly toolchain: BuildToolchain;
  readonly storedAt: string;
}

export interface StoredCompiledArtifact {
  readonly record: CompiledArtifactRecord;
  readonly bytes: Buffer;
}

function parseRecord(value: unknown): CompiledArtifactRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const digest = record.digest;
  const sourceDigest = record.sourceDigest;
  const toolchain = record.toolchain;
  if (typeof record.key !== 'string' || record.key.length === 0 || record.key.length > 512) return undefined;
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
  if (typeof sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(sourceDigest)) return undefined;
  if (typeof record.sizeBytes !== 'number' || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes <= 0) {
    return undefined;
  }
  if (record.sizeBytes > MAX_COMPILED_BYTES) return undefined;
  if (typeof record.entrypoint !== 'string' || record.entrypoint.length === 0 || record.entrypoint.length > 128) {
    return undefined;
  }
  if (typeof record.language !== 'string' || !LANGUAGES.includes(record.language as BotLanguage)) return undefined;
  if (typeof record.storedAt !== 'string') return undefined;
  if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain)) return undefined;
  const candidate = toolchain as Record<string, unknown>;
  if (candidate.language !== record.language || typeof candidate.imageDigest !== 'string') return undefined;
  if (!/^[0-9a-f]{64}$/.test(candidate.imageDigest)) return undefined;
  if (typeof candidate.version !== 'string' || candidate.version.length === 0) return undefined;
  if (!Array.isArray(candidate.flags) || candidate.flags.some((flag) => typeof flag !== 'string')) return undefined;
  return {
    key: record.key,
    digest,
    sizeBytes: record.sizeBytes,
    entrypoint: record.entrypoint,
    language: record.language as BotLanguage,
    sourceDigest,
    toolchain: {
      language: candidate.language as BotLanguage,
      imageDigest: candidate.imageDigest,
      version: candidate.version,
      flags: candidate.flags as string[],
    },
    storedAt: record.storedAt,
  };
}

async function writeAtomic(target: string, bytes: Buffer): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  // The rename itself must be durable before the record is trusted.
  const directory = await open(path.dirname(target), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Only the control plane and the native gateway use this store; no worker path ever reaches it. */
export class CompiledArtifactStore {
  private readonly objectsDir: string;
  private readonly keysDir: string;

  constructor(readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error('Compiled artifact store root must be an absolute path');
    assertPrivateObjectRoot(root, 'Compiled artifact root');
    this.objectsDir = path.join(root, 'objects');
    this.keysDir = path.join(root, 'keys');
  }

  /**
   * Persists `bytes` as the artifact of `key`, durably and idempotently. A re-promotion of the same
   * bytes is a no-op write of the same object; a rebuild that produced different bytes replaces the
   * record, which is the only sane answer when a compiler is not byte-reproducible.
   */
  async promote(input: {
    readonly key: string;
    readonly bytes: Buffer;
    readonly entrypoint: string;
    readonly language: BotLanguage;
    readonly sourceDigest: Digest;
    readonly toolchain: BuildToolchain;
  }): Promise<CompiledArtifactRecord> {
    if (compiledArtifactKey(input.language, input.sourceDigest, input.toolchain) !== input.key) {
      throw new CompiledArtifactError('KEY_MISMATCH', 'Artifact key is not this build key');
    }
    if (input.bytes.length === 0) throw new CompiledArtifactError('ARTIFACT_EMPTY', 'Compiled artifact is empty');
    if (input.bytes.length > MAX_COMPILED_BYTES) {
      throw new CompiledArtifactError('ARTIFACT_TOO_LARGE', `Compiled artifact exceeds ${MAX_COMPILED_BYTES} bytes`);
    }
    const record: CompiledArtifactRecord = {
      key: input.key,
      digest: sha256Hex(input.bytes),
      sizeBytes: input.bytes.length,
      entrypoint: input.entrypoint,
      language: input.language,
      sourceDigest: input.sourceDigest,
      toolchain: input.toolchain,
      storedAt: new Date().toISOString(),
    };
    await this.ensureDirectories();
    await writeAtomic(path.join(this.objectsDir, `${record.digest}.bin`), input.bytes);
    await writeAtomic(path.join(this.keysDir, `${sha256Hex(record.key)}.json`), Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'));
    return record;
  }

  /** Reads `key` back, verified: missing, unreadable or digest-mismatched content is `undefined`. */
  async get(key: string): Promise<StoredCompiledArtifact | undefined> {
    const record = await this.readRecord(key);
    if (!record) return undefined;
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(this.objectsDir, `${record.digest}.bin`));
    } catch {
      return undefined;
    }
    if (bytes.length !== record.sizeBytes || sha256Hex(bytes) !== record.digest) return undefined;
    return { record, bytes };
  }

  /** Resolves the artifact the build for this source and toolchain must have produced. */
  async resolve(
    language: BotLanguage,
    sourceDigest: Digest,
    toolchain: BuildToolchain
  ): Promise<StoredCompiledArtifact | undefined> {
    return this.get(compiledArtifactKey(language, sourceDigest, toolchain));
  }

  private async readRecord(key: string): Promise<CompiledArtifactRecord | undefined> {
    let raw: Buffer;
    try {
      raw = await readFile(path.join(this.keysDir, `${sha256Hex(key)}.json`));
    } catch {
      return undefined;
    }
    try {
      const parsed = parseRecord(JSON.parse(raw.toString('utf8')));
      if (!parsed || parsed.key !== key) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.objectsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.keysDir, { recursive: true, mode: 0o700 });
  }
}
