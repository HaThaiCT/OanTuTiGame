/**
 * Shared submission-source materializer and per-language launcher.
 *
 * Two callers need exactly the same "ZIP bytes → runnable workspace" contract:
 *   - the match executor (`tournaments/execution-service.ts`), which extracts a frozen
 *     submission into `<spool>/<gameId>/{white,black}` before every game, and
 *   - the build pipeline (`builds/build-pipeline.ts`), which extracts a receipt into a
 *     throwaway spool directory, compiles it and smoke-tests it before it can become READY.
 *
 * Keeping the rules in one module is what makes a receipt that passed the build gate actually
 * runnable by the match executor: same validator, same limits, same digest equality check,
 * same entrypoint resolution, same launch commands.
 *
 * The workspace is created fresh (any previous contents are removed), files are written mode
 * 0600 inside mode 0700 directories, and every path is re-checked against the extraction root
 * on the way to disk. Callers own the workspace lifetime: `cleanup()` removes it.
 *
 * WARNING: nothing here is sandboxed. Materializing and launching a submission runs
 * untrusted code with the server's own uid, cwd, environment and file system access. Only the
 * dev-only worker/executor paths (armed by `OANTUTI_DEV_EXECUTION=1`) may call this.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { BotLanguage, Digest, ProjectManifest } from '@oantuti/protocol';
import {
  MAX_EXPANDED_BYTES,
  MAX_FILE_BYTES,
  MAX_REGULAR_FILES,
  computeCanonicalManifest,
  parseAndValidateZip,
  type ArtifactStore,
} from './artifact-store.js';

const execFileAsync = promisify(execFile);

/** Hard ceiling on any one native compile step (C++). */
export const COMPILE_TIMEOUT_MS = 60_000;
/** Compiler stdout/stderr capture limit; diagnostics are truncated further before storage. */
export const COMPILER_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Longest error detail this module ever renders into a message. */
export const MAX_ERROR_DETAIL_CHARS = 2_000;

/**
 * Raised when a stored artifact cannot be turned into a workspace. Carries `statusCode` so the
 * executor can surface it through its own error funnel with the exact same message.
 */
export class SourceMaterializationError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'SourceMaterializationError';
  }
}

/** Raised when a native compile step fails; `message` is `CPP_COMPILE_FAILED: <stderr>`. */
export class SourceCompileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Raw compiler stderr, kept untruncated for evidence digests. */
    readonly stderr = ''
  ) {
    super(message);
    this.name = 'SourceCompileError';
  }
}

export interface MaterializeSourceInput {
  readonly artifactStore: ArtifactStore;
  /** Digest the submission receipt recorded; the extracted ZIP is re-hashed and must match. */
  readonly sourceDigest: Digest;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  /** Exact workspace directory. Created fresh: any existing contents are removed first. */
  readonly spoolDir: string;
}

export interface MaterializedSource {
  /** The extraction root all source files were written into. */
  readonly workDir: string;
  /** Absolute path of the validated entrypoint file inside {@link workDir}. */
  readonly entryPath: string;
  /** Canonical manifest recomputed from the extracted files (digest-verified). */
  readonly manifest: ProjectManifest;
  /** Removes {@link workDir} and everything below it. Idempotent. */
  cleanup(): Promise<void>;
}

/** Resolved way to start a bot: `command`/`args` for the runner, `executablePath` for BotConfig. */
export interface LaunchCommand {
  readonly command: string;
  /** Absolute path of the artifact that gets executed (entrypoint, or the C++ binary). */
  readonly executablePath: string;
  readonly args: readonly string[];
}

/** Where a C++ workspace's binary is placed when no explicit path is given. */
export function cppBinaryPath(workDir: string): string {
  return path.join(workDir, 'bot');
}

/** Rejects absolute paths and any path escaping the extraction root. */
export function resolveInside(rootDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new SourceMaterializationError(400, `ABSOLUTE_PATH_REJECTED: ${relativePath}`);
  }
  const resolved = path.resolve(rootDir, relativePath);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) {
    throw new SourceMaterializationError(400, `PATH_TRAVERSAL_REJECTED: ${relativePath}`);
  }
  return resolved;
}

/**
 * Extracts a stored source artifact into `spoolDir` and resolves its entrypoint.
 *
 * Reuses the intake validator, so the ZIP is subject to MAX_ZIP_BYTES, the traversal/absolute/
 * symlink bans, MAX_REGULAR_FILES / MAX_FILE_BYTES / MAX_EXPANDED_BYTES, the entrypoint
 * existence check and the language/extension agreement. Errors raised by that validator
 * (`ArtifactError`) propagate unchanged; the checks added here raise
 * {@link SourceMaterializationError} with the executor's historical wording.
 */
export async function materializeSource(input: MaterializeSourceInput): Promise<MaterializedSource> {
  const { artifactStore, sourceDigest, language, entrypoint, spoolDir } = input;

  const source = await artifactStore.getSource(sourceDigest);
  if (!source) {
    throw new SourceMaterializationError(
      500,
      `SOURCE_ARTIFACT_MISSING: digest ${sourceDigest} is not present in the artifact store`
    );
  }

  await rm(spoolDir, { recursive: true, force: true });
  await mkdir(spoolDir, { recursive: true, mode: 0o700 });

  const { files, expandedBytes } = parseAndValidateZip(source.zipBuffer, language, entrypoint);

  // Defense in depth on the way to disk: the intake limits are the single source of truth.
  if (files.length > MAX_REGULAR_FILES) {
    throw new SourceMaterializationError(
      413,
      `ZIP exceeds maximum allowed file count of ${MAX_REGULAR_FILES}`
    );
  }
  if (expandedBytes > MAX_EXPANDED_BYTES) {
    throw new SourceMaterializationError(
      413,
      `Source exceeds maximum allowed expanded size of ${MAX_EXPANDED_BYTES} bytes`
    );
  }

  const { manifest, digest } = computeCanonicalManifest(files, language, entrypoint, expandedBytes);
  if (digest !== sourceDigest) {
    throw new SourceMaterializationError(
      500,
      `SOURCE_DIGEST_MISMATCH: stored artifact hashes to ${digest}, submission recorded ${sourceDigest}`
    );
  }

  for (const file of files) {
    if (file.data.length > MAX_FILE_BYTES) {
      throw new SourceMaterializationError(
        413,
        `File ${file.path} exceeds single-file limit of ${MAX_FILE_BYTES} bytes`
      );
    }
    const target = resolveInside(spoolDir, file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.data, { mode: 0o600 });
  }

  // Entrypoint resolution mirrors ArtifactStore.parseAndValidateZip normalization.
  const entryPath = resolveInside(spoolDir, entrypoint.replace(/\\/g, '/').replace(/^\.\//, ''));
  const entrypointStat = await stat(entryPath).catch(() => undefined);
  if (!entrypointStat?.isFile()) {
    throw new SourceMaterializationError(
      500,
      `ENTRYPOINT_NOT_MATERIALIZED: "${entrypoint}" is not a regular file inside ${spoolDir}`
    );
  }

  return {
    workDir: spoolDir,
    entryPath,
    manifest,
    cleanup: async () => {
      await rm(spoolDir, { recursive: true, force: true });
    },
  };
}

/**
 * Per-language launch command, matching the runner's `BotConfig` contract exactly:
 *   - TYPESCRIPT: the repo's tsx CLI (falls back to `node --import tsx`), run by this node.
 *   - PYTHON: `python3 <entry>`.
 *   - CPP: the compiled binary, whose path is `options.cppBinaryPath` when the caller keeps a
 *     digest-keyed compile cache, else `<workDir>/bot` (see {@link compileCppBinary}).
 */
export function resolveLaunch(
  language: BotLanguage,
  entryPath: string,
  workDir: string,
  options: { readonly cppBinaryPath?: string } = {}
): LaunchCommand {
  switch (language) {
    case 'TYPESCRIPT': {
      const tsxCli = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
      const args = existsSync(tsxCli) ? [tsxCli, entryPath] : ['--import', 'tsx', entryPath];
      return { command: process.execPath, executablePath: entryPath, args };
    }
    case 'PYTHON':
      return { command: 'python3', executablePath: entryPath, args: [entryPath] };
    case 'CPP': {
      const binaryPath = options.cppBinaryPath ?? cppBinaryPath(workDir);
      return { command: binaryPath, executablePath: binaryPath, args: [] };
    }
    default: {
      const unsupported: never = language;
      throw new SourceMaterializationError(400, `UNSUPPORTED_LANGUAGE: ${String(unsupported)}`);
    }
  }
}

export interface CppCompileOptions {
  /** Absolute path of the `.cpp` entrypoint inside `workDir`. */
  readonly sourcePath: string;
  /** Extraction root of the source, always added to the include path. */
  readonly workDir: string;
  /** Where the binary is written; its parent directory is created mode 0700. */
  readonly binaryPath: string;
  /**
   * Extra `-I` directories (e.g. the repo's header-only `sdk/cpp`), prepended to the include
   * path so a bot can `#include "oantuti.hpp"`.
   */
  readonly includeDirs?: readonly string[];
  readonly timeoutMs?: number;
}

/**
 * Compiles one C++ entrypoint. Bounded by {@link COMPILE_TIMEOUT_MS} and a capture limit; a
 * failed compile removes the (possibly partial) binary and throws
 * `CPP_COMPILE_FAILED: <stderr>` so the caller can store it as the rejection reason.
 */
export async function compileCppBinary(options: CppCompileOptions): Promise<void> {
  await mkdir(path.dirname(options.binaryPath), { recursive: true, mode: 0o700 });

  const args = ['-O2', '-std=c++20'];
  for (const includeDir of options.includeDirs ?? []) args.push('-I', includeDir);
  args.push('-I', options.workDir, options.sourcePath, '-o', options.binaryPath);

  try {
    await execFileAsync('g++', args, {
      timeout: options.timeoutMs ?? COMPILE_TIMEOUT_MS,
      maxBuffer: COMPILER_MAX_BUFFER_BYTES,
    });
  } catch (err) {
    await rm(options.binaryPath, { force: true });
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr ?? '') : '';
    const detail = stderr.trim() || describeError(err);
    throw new SourceCompileError(
      'CPP_COMPILE_FAILED',
      `CPP_COMPILE_FAILED: ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}`,
      stderr.trim()
    );
  }
}

/** Short, storage-safe rendering of an arbitrary thrown value. */
export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > MAX_ERROR_DETAIL_CHARS ? `${message.slice(0, MAX_ERROR_DETAIL_CHARS)}…` : message;
}
