import { createHash } from 'node:crypto';
import { open, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from '../persistence/db.js';
import type { PoolClient } from 'pg';
import type { BotLanguage, Digest, ProjectFileEntry, ProjectManifest } from '@oantuti/protocol';
import { assertPrivateObjectRoot } from '../persistence/private-root.js';

export const MAX_ZIP_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MAX_REGULAR_FILES = 128;
export const MAX_FILE_BYTES = 256 * 1024; // 256 KiB
export const MAX_EXPANDED_BYTES = 4 * 1024 * 1024; // 4 MiB

export class ArtifactError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export interface ExtractedZipFile {
  readonly path: string;
  readonly size: number;
  readonly data: Buffer;
  readonly sha256: Digest;
}

export interface StoredSourceArtifact {
  readonly digest: Digest;
  readonly storagePath: string;
  readonly manifest: ProjectManifest;
  readonly zipBytes: number;
  readonly expandedBytes: number;
  readonly fileCount: number;
}

const FORBIDDEN_EXTENSIONS = new Set([
  '.exe', '.so', '.dll', '.dylib', '.bin', '.pyc', '.pyo', '.pyd',
  '.o', '.a', '.obj', '.class', '.jar', '.wasm',
]);

export function parseAndValidateZip(
  zipBuffer: Buffer,
  language: BotLanguage,
  entrypoint: string
): { files: ExtractedZipFile[]; expandedBytes: number } {
  if (zipBuffer.length === 0) {
    throw new ArtifactError(400, 'Empty ZIP buffer');
  }
  if (zipBuffer.length > MAX_ZIP_BYTES) {
    throw new ArtifactError(413, `ZIP exceeds maximum allowed size of ${MAX_ZIP_BYTES} bytes`);
  }

  // Find End of Central Directory Record (EOCD signature 0x06054b50)
  let eocdOffset = -1;
  const searchStart = Math.max(0, zipBuffer.length - 65557);
  for (let i = zipBuffer.length - 22; i >= searchStart; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new ArtifactError(400, 'Invalid ZIP: End of Central Directory record not found');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  let offset = cdOffset;
  const files: ExtractedZipFile[] = [];
  const lowerCaseSeen = new Set<string>();
  let totalExpandedBytes = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > zipBuffer.length || zipBuffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new ArtifactError(400, 'Invalid ZIP: corrupt central directory header');
    }

    const method = zipBuffer.readUInt16LE(offset + 10);
    const compressedSize = zipBuffer.readUInt32LE(offset + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
    const nameLen = zipBuffer.readUInt16LE(offset + 28);
    const extraLen = zipBuffer.readUInt16LE(offset + 30);
    const commentLen = zipBuffer.readUInt16LE(offset + 32);
    const externalAttr = zipBuffer.readUInt32LE(offset + 38);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);

    const rawName = zipBuffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    // Check for symlinks in external attributes (Unix mode in top 16 bits: 0o120000 = symlink)
    const unixMode = (externalAttr >> 16) & 0o170000;
    if (unixMode === 0o120000) {
      throw new ArtifactError(400, `ZIP contains forbidden symlink: ${rawName}`);
    }

    // Normalize path: replace backslashes, resolve dots
    const normalized = rawName.replace(/\\/g, '/');
    if (normalized.endsWith('/')) {
      // Directory entry - skip regular file processing
      continue;
    }

    // Path traversal security checks
    if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
      throw new ArtifactError(400, `ZIP contains directory traversal path: ${rawName}`);
    }

    // Case-insensitive collision detection
    const lower = normalized.toLowerCase();
    if (lowerCaseSeen.has(lower)) {
      throw new ArtifactError(400, `ZIP contains duplicate or case-collision file: ${normalized}`);
    }
    lowerCaseSeen.add(lower);

    // Extension check - no compiled binaries
    const ext = path.extname(normalized).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(ext)) {
      throw new ArtifactError(400, `ZIP contains forbidden compiled binary or executable: ${normalized}`);
    }

    // File count check
    if (files.length >= MAX_REGULAR_FILES) {
      throw new ArtifactError(400, `ZIP exceeds maximum allowed file count of ${MAX_REGULAR_FILES}`);
    }

    // Single file size limit
    if (uncompressedSize > MAX_FILE_BYTES) {
      throw new ArtifactError(413, `File ${normalized} exceeds single-file limit of ${MAX_FILE_BYTES} bytes`);
    }

    // Total expanded bytes limit
    totalExpandedBytes += uncompressedSize;
    if (totalExpandedBytes > MAX_EXPANDED_BYTES) {
      throw new ArtifactError(413, `Total decompressed source exceeds maximum allowed ${MAX_EXPANDED_BYTES} bytes`);
    }

    // Read local header and extract data
    if (localHeaderOffset + 30 > zipBuffer.length || zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new ArtifactError(400, `Corrupt local header for file ${normalized}`);
    }
    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;

    if (dataStart + compressedSize > zipBuffer.length) {
      throw new ArtifactError(400, `Corrupt data bounds for file ${normalized}`);
    }
    const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = compressedData;
    } else if (method === 8) {
      try {
        data = inflateRawSync(compressedData);
      } catch (err: unknown) {
        throw new ArtifactError(400, `Failed to decompress ${normalized}: ${err instanceof Error ? err.message : 'corrupt stream'}`);
      }
    } else {
      throw new ArtifactError(400, `Unsupported compression method ${method} in file ${normalized}`);
    }

    if (data.length !== uncompressedSize) {
      throw new ArtifactError(400, `Decompressed size mismatch for ${normalized}`);
    }

    const sha256 = createHash('sha256').update(data).digest('hex');
    files.push({
      path: normalized,
      size: data.length,
      data,
      sha256,
    });
  }

  if (files.length === 0) {
    throw new ArtifactError(400, 'ZIP contains no regular files');
  }

  // Validate entrypoint
  const normalizedEntrypoint = entrypoint.replace(/\\/g, '/').replace(/^\.\//, '');
  const entrypointExists = files.some((f) => f.path === normalizedEntrypoint);
  if (!entrypointExists) {
    throw new ArtifactError(400, `Specified entrypoint "${entrypoint}" not found in ZIP files`);
  }

  // Validate entrypoint extension matches language
  if (language === 'PYTHON' && !normalizedEntrypoint.endsWith('.py')) {
    throw new ArtifactError(400, `Python entrypoint must end in .py: ${entrypoint}`);
  }
  if (language === 'TYPESCRIPT' && !normalizedEntrypoint.endsWith('.ts') && !normalizedEntrypoint.endsWith('.js')) {
    throw new ArtifactError(400, `TypeScript entrypoint must end in .ts or .js: ${entrypoint}`);
  }
  if (language === 'CPP' && !normalizedEntrypoint.endsWith('.cpp')) {
    throw new ArtifactError(400, `C++ entrypoint must end in .cpp: ${entrypoint}`);
  }

  return { files, expandedBytes: totalExpandedBytes };
}

export function computeCanonicalManifest(
  files: readonly ExtractedZipFile[],
  language: BotLanguage,
  entrypoint: string,
  totalExpandedBytes: number
): { manifest: ProjectManifest; digest: Digest } {
  // Sort files strictly by normalized path
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const fileEntries: ProjectFileEntry[] = sortedFiles.map((f) => ({
    path: f.path,
    size: f.size,
    sha256: f.sha256,
  }));

  const manifest: ProjectManifest = {
    language,
    entrypoint,
    fileCount: sortedFiles.length,
    totalBytes: totalExpandedBytes,
    files: fileEntries,
  };

  const canonicalJson = JSON.stringify(manifest);
  const digest = createHash('sha256').update(canonicalJson).digest('hex');
  return { manifest, digest };
}

/** Application-owned fallback; explicit configuration always remains operator-owned. */
function resolveSourceRoot(argument?: string): { root: string; ownedByConvention: boolean } {
  const configured = process.env.OANTUTI_SUBMISSION_DIR;
  const shared = process.env.OANTUTI_OBJECTS_DIR;
  if (configured === '') throw new Error('OANTUTI_SUBMISSION_DIR must not be empty');
  if (shared === '') throw new Error('OANTUTI_OBJECTS_DIR must not be empty');
  if (argument !== undefined) return { root: argument, ownedByConvention: false };
  if (configured !== undefined) return { root: configured, ownedByConvention: false };
  if (shared !== undefined) return { root: path.join(shared, 'sources'), ownedByConvention: false };
  return { root: path.join(os.homedir(), '.local/share/oantuti/development/objects/sources'), ownedByConvention: true };
}

export class ArtifactStore {
  readonly storageRoot: string;
  constructor(
    private readonly db: Database,
    storageRoot?: string,
    options: { readonly ownedByConvention?: boolean } = {}
  ) {
    const resolved = resolveSourceRoot(storageRoot);
    this.storageRoot = resolved.root;
    assertPrivateObjectRoot(this.storageRoot, 'Submission source root', { ownedByConvention: options.ownedByConvention ?? resolved.ownedByConvention });
  }

  async storeSource(
    zipBuffer: Buffer,
    language: BotLanguage,
    entrypoint: string,
    client?: PoolClient
  ): Promise<StoredSourceArtifact> {
    if (!client) return this.db.withTransaction((transaction) => this.storeSource(zipBuffer, language, entrypoint, transaction));
    await client.query('SELECT pg_advisory_xact_lock_shared(1868657748, 26)');
    const { files, expandedBytes } = parseAndValidateZip(zipBuffer, language, entrypoint);
    const { manifest, digest } = computeCanonicalManifest(files, language, entrypoint, expandedBytes);

    await mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
    const filePath = path.join(this.storageRoot, `${digest}.zip`);

    // Never rewrite a canonical object: different ZIP encodings may name the same source manifest.
    let storedZipBytes = zipBuffer.length;
    try {
      const fileHandle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await fileHandle.writeFile(zipBuffer); await fileHandle.sync(); }
      finally { await fileHandle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await existing.stat();
        if (!info.isFile() || info.size > MAX_ZIP_BYTES) throw new ArtifactError(500, 'Existing source object is not a bounded regular file');
        const bytes = await existing.readFile();
        const parsed = parseAndValidateZip(bytes, language, entrypoint);
        if (computeCanonicalManifest(parsed.files, language, entrypoint, parsed.expandedBytes).digest !== digest) throw new ArtifactError(500, 'Existing source object is corrupt');
        storedZipBytes = bytes.length;
      } finally { await existing.close(); }
    }

    // Fsync parent directory
    const dirHandle = await open(this.storageRoot, 'r');
    try {
      await dirHandle.sync(); // fsync dir
    } finally {
      await dirHandle.close();
    }

    // Insert into submission_sources in PostgreSQL (same client when inside a transaction,
    // so a burst of concurrent submissions cannot exhaust the pool).
    const runner = (client ?? this.db) as { query: (text: string, params?: readonly unknown[]) => Promise<unknown> };
    await runner.query(
      `INSERT INTO submission_sources (digest, storage_path, zip_bytes, expanded_bytes, file_count, manifest)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (digest) DO UPDATE
       SET manifest = EXCLUDED.manifest`,
      [digest, filePath, storedZipBytes, expandedBytes, files.length, JSON.stringify(manifest)]
    );

    return {
      digest,
      storagePath: filePath,
      manifest,
      zipBytes: storedZipBytes,
      expandedBytes,
      fileCount: files.length,
    };
  }

  async getSource(digest: Digest): Promise<{ manifest: ProjectManifest; zipBuffer: Buffer } | undefined> {
    const res = await this.db.query<{ storage_path: string; manifest: ProjectManifest }>(
      'SELECT storage_path, manifest FROM submission_sources WHERE digest = $1',
      [digest]
    );
    const row = res.rows[0];
    if (!row) return undefined;

    const fileHandle = await open(row.storage_path, 'r');
    try {
      const buffer = await fileHandle.readFile();
      return { manifest: row.manifest, zipBuffer: buffer };
    } finally {
      await fileHandle.close();
    }
  }
}
