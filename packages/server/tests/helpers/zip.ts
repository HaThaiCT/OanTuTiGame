import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

/**
 * Builds a minimal ZIP archive in memory for intake tests.
 *
 * `content` accepts a string (encoded UTF-8) or a Buffer, so a test can produce exact byte sizes and
 * high-entropy payloads that survive deflate. The CRC field is left at zero: intake validation reads
 * names, sizes and offsets — it never verifies CRCs, and a real client's archive is checked by
 * `parseAndValidateZip` itself.
 */
export function createZip(files: Record<string, string | Buffer>): Buffer {
  const fileEntries: { name: string; data: Buffer }[] = [];
  for (const [name, content] of Object.entries(files)) {
    fileEntries.push({ name, data: typeof content === 'string' ? Buffer.from(content, 'utf8') : content });
  }

  const chunks: Buffer[] = [];
  const cdHeaders: Buffer[] = [];
  let localOffset = 0;

  for (const f of fileEntries) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const compressedData = zlib.deflateRawSync(f.data);

    // Local file header (30 bytes + name + data)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // min version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(0, 14); // crc (simplified)
    local.writeUInt32LE(compressedData.length, 18); // compressed size
    local.writeUInt32LE(f.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26); // name length
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, nameBuf, compressedData);

    // Central directory header (46 bytes + name)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(8, 10); // deflate
    cd.writeUInt32LE(0, 12); // time/date
    cd.writeUInt32LE(0, 16); // crc
    cd.writeUInt32LE(compressedData.length, 20); // compressed size
    cd.writeUInt32LE(f.data.length, 24); // uncompressed size
    cd.writeUInt16LE(nameBuf.length, 28); // name length
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attr
    cd.writeUInt32LE(0, 38); // external attr
    cd.writeUInt32LE(localOffset, 42); // local header offset

    cdHeaders.push(cd, nameBuf);
    localOffset += 30 + nameBuf.length + compressedData.length;
  }

  const cdTotalSize = cdHeaders.reduce((sum, b) => sum + b.length, 0);
  const cdOffset = localOffset;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(fileEntries.length, 8); // disk entries
  eocd.writeUInt16LE(fileEntries.length, 10); // total entries
  eocd.writeUInt32LE(cdTotalSize, 12); // cd size
  eocd.writeUInt32LE(cdOffset, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment length

  chunks.push(...cdHeaders, eocd);
  return Buffer.concat(chunks);
}
