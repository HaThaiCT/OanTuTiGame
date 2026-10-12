import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Specification Package Integrity', () => {
  const requiredDocs = [
    'README.md',
    'docs/specs/README.md',
    'docs/specs/01-PRD-GDD.md',
    'docs/specs/02-SYSTEM-ARCHITECTURE.md',
    'docs/specs/03-NETWORK-PROTOCOL-SPEC.md',
    'docs/specs/04-BOT-RUNNER-IPC-SPEC.md',
    'docs/specs/05-DATA-MODELS-DATABASE-SPEC.md',
    'docs/specs/06-UI-UX-VISUALIZER-SPEC.md',
    'docs/specs/07-TEST-PLAN-QA-SPEC.md',
    'docs/specs/08-PROJECT-ROADMAP-WBS.md',
    'docs/specs/proto/oantuti.proto',
    'docs/specs/maps/schema.json'
  ];
  it.each(requiredDocs)('should have artifact %s present and non-empty', (docPath) => {
    const fullPath = path.resolve(process.cwd(), docPath);
    expect(fs.existsSync(fullPath), `Missing document: ${docPath}`).toBe(true);
    const content = fs.readFileSync(fullPath, 'utf-8');
    expect(content.trim().length).toBeGreaterThan(200);
  });
});
