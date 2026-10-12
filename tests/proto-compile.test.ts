import { describe, it, expect } from 'vitest';
import * as protobuf from 'protobufjs';
import Ajv from 'ajv';
import * as fs from 'fs';
import * as path from 'path';

describe('Protobuf & Map Schema Verification', () => {
  it('should compile oantuti.proto without errors', async () => {
    const protoPath = path.resolve(process.cwd(), 'docs/specs/proto/oantuti.proto');
    const root = await protobuf.load(protoPath);
    expect(root.lookupType('oantuti.MatchInitFrame')).toBeDefined();
    expect(root.lookupType('oantuti.TurnDeltaFrame')).toBeDefined();
    expect(root.lookupType('oantuti.MatchEndFrame')).toBeDefined();
    expect(root.lookupType('oantuti.WebSocketEnvelope')).toBeDefined();
  });

  it('should validate sample-donut.map.json against maps/schema.json', () => {
    const ajv = new Ajv();
    const schema = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'docs/specs/maps/schema.json'), 'utf-8'));
    const sample = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'docs/specs/maps/sample-donut.map.json'), 'utf-8'));
    const validate = ajv.compile(schema);
    const valid = validate(sample);
    expect(valid).toBe(true);
  });
});
