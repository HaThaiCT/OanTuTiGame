import { expect, it } from 'vitest';
import { Envelope } from '../src/execution.js';

it('preserves decimal uint64 and discriminated lifecycle payload across binary wire', () => {
  const envelope = Envelope.create({
    protocolVersion: 2, gameId: 'game', attemptId: 'attempt',
    sequence: '9007199254740993', requestId: 'request',
    manifestSha256: new Uint8Array(32).fill(7),
    message: { $case: 'stopGame', stopGame: { reasonCode: 'OPERATOR_STOP' } },
  });
  const decoded = Envelope.decode(Envelope.encode(envelope).finish());
  expect(decoded.sequence).toBe('9007199254740993');
  expect(decoded.message).toEqual({ $case: 'stopGame', stopGame: { reasonCode: 'OPERATOR_STOP' } });
  expect(decoded.manifestSha256).toEqual(new Uint8Array(32).fill(7));
});
