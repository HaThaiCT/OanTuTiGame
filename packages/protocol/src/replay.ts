/**
 * Binary Replay (.oantuti) Packer & Reader
 * Specifications adhere to docs/specs/03-NETWORK-PROTOCOL-SPEC.md Section 4.
 *
 * File Structure:
 * - Magic: "OANTUTI1" (8 bytes ASCII)
 * - InitFrameLen: uint32 BE (4 bytes)
 * - MatchInitFrame payload
 * - TotalDeltaCount: uint32 BE (4 bytes)
 * - N x [DeltaLen: uint16 BE (2 bytes) + TurnDeltaFrame payload]
 * - EndFrameLen: uint32 BE (4 bytes)
 * - MatchEndFrame payload
 */

import {
  MatchInitFrameMessage,
  TurnDeltaFrameMessage,
  MatchEndFrameMessage,
} from './types.js';
import {
  encodeMatchInitFrame,
  decodeMatchInitFrame,
  encodeTurnDeltaFrame,
  decodeTurnDeltaFrame,
  encodeMatchEndFrame,
  decodeMatchEndFrame,
} from './codec.js';

const MAGIC_BYTES = new Uint8Array([0x4f, 0x41, 0x4e, 0x54, 0x55, 0x54, 0x49, 0x31]); // "OANTUTI1"

export function packReplay(
  init: MatchInitFrameMessage,
  deltas: readonly TurnDeltaFrameMessage[],
  end: MatchEndFrameMessage
): Uint8Array {
  const encodedInit = encodeMatchInitFrame(init);
  const encodedDeltas = deltas.map((d) => encodeTurnDeltaFrame(d));
  const encodedEnd = encodeMatchEndFrame(end);

  let totalSize = 8 + 4 + encodedInit.length + 4;
  for (const d of encodedDeltas) {
    totalSize += 2 + d.length;
  }
  totalSize += 4 + encodedEnd.length;

  const buffer = new Uint8Array(totalSize);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // 1. Magic Header
  buffer.set(MAGIC_BYTES, 0);
  let offset = 8;

  // 2. Init Frame
  view.setUint32(offset, encodedInit.length, false);
  offset += 4;
  buffer.set(encodedInit, offset);
  offset += encodedInit.length;

  // 3. Delta Count
  view.setUint32(offset, encodedDeltas.length, false);
  offset += 4;

  // 4. Delta Stream
  for (const deltaBytes of encodedDeltas) {
    if (deltaBytes.length > 65535) {
      throw new Error(`TurnDeltaFrame size ${deltaBytes.length} exceeds 16-bit uint16 limit`);
    }
    view.setUint16(offset, deltaBytes.length, false);
    offset += 2;
    buffer.set(deltaBytes, offset);
    offset += deltaBytes.length;
  }

  // 5. End Frame
  view.setUint32(offset, encodedEnd.length, false);
  offset += 4;
  buffer.set(encodedEnd, offset);
  offset += encodedEnd.length;

  return buffer;
}

export function unpackReplay(buffer: Uint8Array): {
  init: MatchInitFrameMessage;
  deltas: TurnDeltaFrameMessage[];
  end: MatchEndFrameMessage;
} {
  if (buffer.length < 20) {
    throw new Error(`Replay file is too small: ${buffer.length} bytes`);
  }

  // Verify Magic Header
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== MAGIC_BYTES[i]) {
      throw new Error('Invalid replay file: missing OANTUTI1 magic header');
    }
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 8;

  // Init Frame
  const initLen = view.getUint32(offset, false);
  offset += 4;
  if (offset + initLen > buffer.length) {
    throw new Error('Truncated replay file while reading MatchInitFrame');
  }
  const init = decodeMatchInitFrame(buffer.subarray(offset, offset + initLen));
  offset += initLen;

  // Delta Stream
  const totalDeltas = view.getUint32(offset, false);
  offset += 4;
  const deltas: TurnDeltaFrameMessage[] = [];

  for (let i = 0; i < totalDeltas; i++) {
    if (offset + 2 > buffer.length) {
      throw new Error(`Truncated replay file at delta frame ${i}`);
    }
    const deltaLen = view.getUint16(offset, false);
    offset += 2;
    if (offset + deltaLen > buffer.length) {
      throw new Error(`Truncated replay file payload at delta frame ${i}`);
    }
    const delta = decodeTurnDeltaFrame(buffer.subarray(offset, offset + deltaLen));
    deltas.push(delta);
    offset += deltaLen;
  }

  // End Frame
  if (offset + 4 > buffer.length) {
    throw new Error('Truncated replay file while reading MatchEndFrame length');
  }
  const endLen = view.getUint32(offset, false);
  offset += 4;
  if (offset + endLen > buffer.length) {
    throw new Error('Truncated replay file while reading MatchEndFrame payload');
  }
  const end = decodeMatchEndFrame(buffer.subarray(offset, offset + endLen));

  return { init, deltas, end };
}
