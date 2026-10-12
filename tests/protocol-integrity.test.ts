import { describe, it, expect } from 'vitest';
import * as protobuf from 'protobufjs';
import * as fs from 'fs';
import * as path from 'path';

describe('Protocol & Specification Refinements', () => {
  it('should include PROTOCOL_VIOLATION in proto WinReason enum', async () => {
    const protoPath = path.resolve(process.cwd(), 'docs/specs/proto/oantuti.proto');
    const root = await protobuf.load(protoPath);
    const winReasonEnum = root.lookupEnum('oantuti.WinReason');
    expect(winReasonEnum.values['PROTOCOL_VIOLATION']).toBeDefined();
  });

  it('should encode a TurnDeltaFrame to less than 200 bytes', async () => {
    const protoPath = path.resolve(process.cwd(), 'docs/specs/proto/oantuti.proto');
    const root = await protobuf.load(protoPath);
    const TurnDeltaFrame = root.lookupType('oantuti.TurnDeltaFrame');
    
    const samplePayload = {
      turnNumber: 42,
      activePlayer: 1, // WHITE
      action: {
        pieceId: 3,
        targetPos: { x: 4, y: 5 }
      },
      capture: {
        attackerId: 3,
        victimId: 12,
        victimType: 2, // SCISSORS
        pos: { x: 4, y: 5 }
      },
      timeConsumedNs: 14200000,
      isGameOver: false,
      winner: 0,
      winReason: 0
    };

    const errMsg = TurnDeltaFrame.verify(samplePayload);
    expect(errMsg).toBeNull();

    const buffer = TurnDeltaFrame.encode(TurnDeltaFrame.create(samplePayload)).finish();
    expect(buffer.length).toBeLessThanOrEqual(200);
    expect(buffer.length).toBeLessThan(60); // Realistically ~35-50 bytes
  });

  it('should ensure database DDL matches PROTOCOL_VIOLATION win reason', () => {
    const dbDoc = fs.readFileSync(path.resolve(process.cwd(), 'docs/specs/05-DATA-MODELS-DATABASE-SPEC.md'), 'utf-8');
    expect(dbDoc).toContain("'PROTOCOL_VIOLATION'");
  });

  it('should ensure replay file format specifies frame count in 03-NETWORK-PROTOCOL-SPEC.md', () => {
    const protocolDoc = fs.readFileSync(path.resolve(process.cwd(), 'docs/specs/03-NETWORK-PROTOCOL-SPEC.md'), 'utf-8');
    expect(protocolDoc).toContain('TotalDeltaCount');
  });
});
