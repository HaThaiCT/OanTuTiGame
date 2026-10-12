/**
 * Binary WebSocket Framing (5-byte fixed header)
 * Structure:
 * [Byte 0: MsgType (1B)] [Bytes 1..4: PayloadLength (uint32 BE)] [Bytes 5..N: Protobuf Payload]
 */

import { WebSocketMessageType } from './types.js';

export function encodeWebSocketFrame(
  type: WebSocketMessageType,
  payload: Uint8Array
): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = type;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(1, payload.length, false); // Big-Endian
  frame.set(payload, 5);
  return frame;
}

export function decodeWebSocketFrame(buffer: Uint8Array): {
  type: WebSocketMessageType;
  payload: Uint8Array;
} {
  if (buffer.length < 5) {
    throw new Error(`Invalid WebSocket frame: expected at least 5 bytes, got ${buffer.length}`);
  }

  const type = buffer[0] as WebSocketMessageType;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const payloadLength = view.getUint32(1, false);

  if (buffer.length < 5 + payloadLength) {
    throw new Error(
      `Truncated WebSocket frame: expected ${5 + payloadLength} bytes, got ${buffer.length}`
    );
  }

  const payload = buffer.subarray(5, 5 + payloadLength);
  return { type, payload };
}
