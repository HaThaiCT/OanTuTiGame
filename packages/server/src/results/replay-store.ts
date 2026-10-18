import { createHash } from 'node:crypto';
import { mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, fsyncSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Digest } from '@oantuti/protocol';

export const REPLAY_V2_MAGIC = 'OANTUTI2'; // 8-byte magic for v2 replays

export interface ReplayV2Payload {
  readonly gameId: string;
  readonly attemptId: string;
  readonly mapId: string;
  readonly rulesRevision: string;
  readonly manifestDigest: Digest;
  readonly totalTurns: number;
  readonly winner: number;
  readonly reason: string;
  readonly disposition: string;
  readonly trace: readonly unknown[];
}

export interface StoredReplay {
  readonly digest: Digest;
  readonly sizeBytes: number;
  readonly absolutePath: string;
}

export class ReplayStore {
  constructor(
    private readonly storageRoot: string = '/home/ha-thai/.local/share/oantuti/development/objects/replays',
    private readonly stagingRoot: string = '/home/ha-thai/.local/share/oantuti/development/objects/staging'
  ) {
    mkdirSync(this.storageRoot, { recursive: true });
    mkdirSync(this.stagingRoot, { recursive: true });
  }

  /**
   * Serializes a game replay into the canonical OANTUTI2 binary format.
   *
   * Binary Layout:
   * - Magic: "OANTUTI2" (8 bytes ASCII)
   * - Version: uint32 BE (4 bytes) = 2
   * - ManifestDigestLen: uint16 BE (2 bytes) + ManifestDigest string
   * - PayloadJsonLen: uint32 BE (4 bytes) + Canonical JSON payload (trace, metadata)
   * - Trailing SHA-256 Checksum: 32 bytes raw SHA-256 over all preceding bytes
   */
  serializeReplayV2(payload: ReplayV2Payload): Buffer {
    const magicBuf = Buffer.from(REPLAY_V2_MAGIC, 'ascii');
    const versionBuf = Buffer.alloc(4);
    versionBuf.writeUInt32BE(2, 0);

    const manifestBuf = Buffer.from(payload.manifestDigest, 'utf8');
    const manifestLenBuf = Buffer.alloc(2);
    manifestLenBuf.writeUInt16BE(manifestBuf.length, 0);

    const jsonPayload = Buffer.from(JSON.stringify(payload), 'utf8');
    const jsonLenBuf = Buffer.alloc(4);
    jsonLenBuf.writeUInt32BE(jsonPayload.length, 0);

    const body = Buffer.concat([magicBuf, versionBuf, manifestLenBuf, manifestBuf, jsonLenBuf, jsonPayload]);
    const checksum = createHash('sha256').update(body).digest();

    return Buffer.concat([body, checksum]);
  }

  /**
   * Unpacks and verifies an OANTUTI2 replay binary buffer.
   */
  deserializeReplayV2(buffer: Buffer): ReplayV2Payload {
    if (buffer.length < 8 + 4 + 2 + 4 + 32) {
      throw new Error('Replay buffer too short to contain valid OANTUTI2 structure');
    }

    const magic = buffer.subarray(0, 8).toString('ascii');
    if (magic !== REPLAY_V2_MAGIC) {
      throw new Error(`Invalid replay magic: expected ${REPLAY_V2_MAGIC}, got ${magic}`);
    }

    const version = buffer.readUInt32BE(8);
    if (version !== 2) {
      throw new Error(`Unsupported replay version: ${version}`);
    }

    const bodyWithoutChecksum = buffer.subarray(0, buffer.length - 32);
    const expectedChecksum = buffer.subarray(buffer.length - 32);
    const actualChecksum = createHash('sha256').update(bodyWithoutChecksum).digest();

    if (!expectedChecksum.equals(actualChecksum)) {
      throw new Error('Replay checksum mismatch: corruption detected');
    }

    const manifestLen = buffer.readUInt16BE(12);
    let offset = 14;
    const manifestDigest = buffer.subarray(offset, offset + manifestLen).toString('utf8');
    offset += manifestLen;

    const jsonLen = buffer.readUInt32BE(offset);
    offset += 4;
    const jsonBuf = buffer.subarray(offset, offset + jsonLen);
    const payload = JSON.parse(jsonBuf.toString('utf8')) as ReplayV2Payload;

    return payload;
  }

  /**
   * Stage a replay buffer into staging area with fsync on both file and directory.
   */
  stageReplay(stagingKey: string, replayBuffer: Buffer): { stagingPath: string; digest: Digest } {
    const stagingPath = join(this.stagingRoot, stagingKey);
    mkdirSync(dirname(stagingPath), { recursive: true });

    // Write and fsync file
    const fd = openSync(stagingPath, 'w');
    try {
      writeFileSync(fd, replayBuffer);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    // fsync parent directory
    this.fsyncDirectory(dirname(stagingPath));

    const digest = createHash('sha256').update(replayBuffer).digest('hex');
    return { stagingPath, digest };
  }

  /**
   * Promote staged replay to immutable storage with fsync and atomic rename.
   */
  promoteStagedReplay(stagingPath: string, expectedDigest: Digest): StoredReplay {
    if (!existsSync(stagingPath)) {
      throw new Error(`Staged replay not found at ${stagingPath}`);
    }

    const buffer = readFileSync(stagingPath);
    const actualDigest = createHash('sha256').update(buffer).digest('hex');
    if (actualDigest !== expectedDigest) {
      throw new Error(`Digest mismatch on promote: expected ${expectedDigest}, got ${actualDigest}`);
    }

    const targetFileName = `${actualDigest}.oantuti`;
    const targetPath = join(this.storageRoot, targetFileName);

    // Atomic rename
    renameSync(stagingPath, targetPath);

    // fsync target directory
    this.fsyncDirectory(this.storageRoot);

    return {
      digest: actualDigest,
      sizeBytes: buffer.length,
      absolutePath: targetPath,
    };
  }

  /**
   * Reads an immutable replay by digest.
   */
  readReplay(digest: Digest): Buffer {
    const targetPath = join(this.storageRoot, `${digest}.oantuti`);
    if (!existsSync(targetPath)) {
      throw new Error(`Replay object not found for digest: ${digest}`);
    }
    const buffer = readFileSync(targetPath);
    const actualDigest = createHash('sha256').update(buffer).digest('hex');
    if (actualDigest !== digest) {
      throw new Error(`Replay object integrity failed: digest mismatch`);
    }
    return buffer;
  }

  private fsyncDirectory(dirPath: string): void {
    try {
      const dirFd = openSync(dirPath, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directories on some virtual FS or tmpfs may not support fsync; ignore ENOTSUP / EINVAL
    }
  }
}
