import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  ArtifactError,
  MAX_EXPANDED_BYTES,
  MAX_FILE_BYTES,
  MAX_REGULAR_FILES,
  MAX_ZIP_BYTES,
  parseAndValidateZip,
} from '../src/submissions/artifact-store.js';
import { createZip } from './helpers/zip.js';

/**
 * Source limits from 01-PRODUCT-REQUIREMENTS §103: 128 regular files **including the manifest**,
 * 256 KiB per file, 4 MiB total expanded bytes for every flow, and 2 MiB for the compressed ZIP
 * itself. The boundaries are the point: a project may sit exactly on a limit, one unit past it is
 * refused, and the refusal carries the specific quota so an operator can explain it.
 */
function expectArtifactError(run: () => unknown, statusCode: number, messagePart: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactError);
    expect((error as ArtifactError).statusCode).toBe(statusCode);
    expect((error as Error).message).toContain(messagePart);
    return;
  }
  throw new Error('expected the intake to reject this archive');
}

describe('S05: source upload limits', () => {
  it('accepts a project sitting exactly on the byte limits', () => {
    // 16 × 256 KiB = 4 MiB expanded, every file exactly at the per-file cap (the checks are `>`).
    const files: Record<string, Buffer | string> = { 'bot.py': Buffer.alloc(MAX_FILE_BYTES, 0x61) };
    for (let index = 1; index < MAX_EXPANDED_BYTES / MAX_FILE_BYTES; index += 1) {
      files[`module_${index}.py`] = Buffer.alloc(MAX_FILE_BYTES, 0x61);
    }

    const parsed = parseAndValidateZip(createZip(files), 'PYTHON', 'bot.py');
    expect(parsed.files).toHaveLength(MAX_EXPANDED_BYTES / MAX_FILE_BYTES);
    expect(parsed.expandedBytes).toBe(MAX_EXPANDED_BYTES);
  });

  it('accepts 127 uploaded files, because the stored manifest is the 128th', () => {
    const files: Record<string, string> = { 'bot.py': 'print("ok")\n' };
    for (let index = 1; index <= MAX_REGULAR_FILES - 2; index += 1) {
      files[`mod_${index}.py`] = '# helper\n';
    }
    expect(Object.keys(files)).toHaveLength(MAX_REGULAR_FILES - 1);

    const parsed = parseAndValidateZip(createZip(files), 'PYTHON', 'bot.py');
    expect(parsed.files).toHaveLength(MAX_REGULAR_FILES - 1);
  });

  it('refuses the 128th uploaded file, because the manifest already counts towards the cap', () => {
    const files: Record<string, string> = { 'bot.py': 'print("ok")\n' };
    for (let index = 1; index <= MAX_REGULAR_FILES; index += 1) {
      files[`mod_${index}.py`] = '# helper\n';
    }
    expect(Object.keys(files)).toHaveLength(MAX_REGULAR_FILES + 1);

    expectArtifactError(
      () => parseAndValidateZip(createZip(files), 'PYTHON', 'bot.py'),
      400,
      `maximum allowed file count of ${MAX_REGULAR_FILES}`
    );
  });

  it('refuses a single file above 256 KiB with 413', () => {
    expectArtifactError(
      () => parseAndValidateZip(createZip({ 'bot.py': Buffer.alloc(MAX_FILE_BYTES + 1, 0x61) }), 'PYTHON', 'bot.py'),
      413,
      `single-file limit of ${MAX_FILE_BYTES}`
    );
  });

  it('refuses expanded source above 4 MiB with 413', () => {
    const files: Record<string, Buffer> = { 'bot.py': Buffer.alloc(MAX_FILE_BYTES, 0x61) };
    for (let index = 1; index <= MAX_EXPANDED_BYTES / MAX_FILE_BYTES; index += 1) {
      files[`module_${index}.py`] = Buffer.alloc(MAX_FILE_BYTES, 0x61);
    }

    expectArtifactError(
      () => parseAndValidateZip(createZip(files), 'PYTHON', 'bot.py'),
      413,
      'Total decompressed source exceeds maximum allowed'
    );
  });

  it('refuses a ZIP above 2 MiB with 413 before parsing any entry', () => {
    // High-entropy content survives deflate, so the archive itself crosses the compressed cap even
    // though the delivered source would be far smaller.
    const incompressible = randomBytes(2 * 1024 * 1024 + 512 * 1024);

    expectArtifactError(
      () => parseAndValidateZip(createZip({ 'bot.py': incompressible }), 'PYTHON', 'bot.py'),
      413,
      `ZIP exceeds maximum allowed size of ${MAX_ZIP_BYTES}`
    );
  });

  it('caps the real inflate of a lying central directory at the declared per-file limit', () => {
    // The per-file and total checks only see the central directory's *declared* sizes, so a
    // forged archive can claim a tiny field while its deflate stream expands far past the cap —
    // the actual decompression must hit the same wall instead of trusting the metadata.
    const bombPayload = Buffer.alloc(3 * 256 * 1024, 0x61); // 768 KiB of near-incompressible filler
    const deflateStream = deflateRawSync(bombPayload);
    expect(deflateStream.length).toBeLessThan(64 * 1024);

    const zip = createZip({ 'bot.py': bombPayload });
    const nameLength = Buffer.byteLength('bot.py', 'utf8');
    const centralOffset = 30 + nameLength + deflateStream.length;
    zip.writeUInt32LE(120, 22); // local header: lie about the uncompressed size
    zip.writeUInt32LE(120, centralOffset + 24); // central directory: the same lie

    expectArtifactError(
      () => parseAndValidateZip(zip, 'PYTHON', 'bot.py'),
      413,
      `single-file limit of ${MAX_FILE_BYTES}`
    );
  });
});
