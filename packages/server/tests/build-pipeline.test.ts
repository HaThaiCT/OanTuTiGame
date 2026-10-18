import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { BotLanguage } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { BuildPipeline, BuildPipelineError } from '../src/builds/build-pipeline.js';

const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
const buildRoot = path.join(os.tmpdir(), `oantuti-build-pipeline-${runId}`);

function createZip(files: Record<string, string>): Buffer {
  const fileEntries: { name: string; data: Buffer }[] = [];
  for (const [name, content] of Object.entries(files)) {
    fileEntries.push({ name, data: Buffer.from(content, 'utf8') });
  }

  const chunks: Buffer[] = [];
  const cdHeaders: Buffer[] = [];
  let localOffset = 0;

  for (const f of fileEntries) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const compressedData = zlib.deflateRawSync(f.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressedData.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressedData);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(compressedData.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(localOffset, 42);
    cdHeaders.push(cd, nameBuf);

    localOffset += 30 + nameBuf.length + compressedData.length;
  }

  const cdTotalSize = cdHeaders.reduce((sum, b) => sum + b.length, 0);
  const cdOffset = localOffset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fileEntries.length, 8);
  eocd.writeUInt16LE(fileEntries.length, 10);
  eocd.writeUInt32LE(cdTotalSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  chunks.push(...cdHeaders, eocd);
  return Buffer.concat(chunks);
}

function commandAvailable(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Self-contained TypeScript bot: answers the INIT handshake and nothing else. */
const TS_BOT = [
  'import * as readline from "node:readline";',
  '',
  'const rl = readline.createInterface({ input: process.stdin });',
  'rl.on("line", (line) => {',
  '  const message = JSON.parse(line);',
  '  if (message.type === "INIT") {',
  '    process.stdout.write(JSON.stringify({ status: "READY" }) + "\\n");',
  '  }',
  '});',
  '',
].join('\n');

/** Same bot with a syntax error: TYPESCRIPT has no compile step, so the smoke test must catch it. */
const TS_BROKEN = 'const broken: = ;\n';

/** Self-contained C++ bot: prints READY as soon as an INIT line arrives. */
const CPP_BOT = [
  '#include <iostream>',
  '#include <string>',
  '',
  'int main() {',
  '  std::string line;',
  '  while (std::getline(std::cin, line)) {',
  '    if (line.find("\\"INIT\\"") != std::string::npos) {',
  '      std::cout << "{\\"status\\": \\"READY\\"}" << std::endl;',
  '      break;',
  '    }',
  '  }',
  '  return 0;',
  '}',
  '',
].join('\n');

/** Unbalanced brace block: g++ rejects it before anything can run. */
const CPP_BROKEN = 'int main() {\n  return 0;\n';

/** Valid Python, but it never speaks the protocol: exits before answering INIT. */
const PY_EXITS_IMMEDIATELY = 'import sys\nsys.exit(0)\n';

const hasGpp = commandAvailable('g++');


/** Multi-file projects: the entrypoint imports a sibling module in each language. */
const TS_MULTI = {
  'bot.ts': [
    'import * as readline from "node:readline";',
    'import { answer } from "./helper";',
    'const rl = readline.createInterface({ input: process.stdin });',
    'rl.on("line", (line) => {',
    '  const message = JSON.parse(line);',
    '  if (message.type === "INIT") {',
    '    process.stdout.write(JSON.stringify({ status: answer() }) + "\\n");',
    '  }',
    '});',
    '',
  ].join('\n'),
  'helper.ts': 'export function answer(): string {\n  return "READY";\n}\n',
};

const PY_MULTI = {
  'bot.py': [
    'import json, sys',
    'from helper import answer',
    'for line in sys.stdin:',
    '    message = json.loads(line)',
    '    if message.get("type") == "INIT":',
    '        print(json.dumps({"status": answer()}), flush=True)',
    '        break',
    '',
  ].join('\n'),
  'helper.py': 'def answer():\n    return "READY"\n',
};

const CPP_MULTI = {
  'bot.cpp': [
    '#include <iostream>',
    '#include <string>',
    '#include "helper.hpp"',
    'int main() {',
    '  std::string line;',
    '  while (std::getline(std::cin, line)) {',
    '    if (line.find("\\"INIT\\"") != std::string::npos) {',
    '      std::cout << "{\\"status\\": \\"" << answer() << "\\"}" << std::endl;',
    '      break;',
    '    }',
    '  }',
    '  return 0;',
    '}',
    '',
  ].join('\n'),
  'helper.hpp': '#pragma once\ninline const char* answer() { return "READY"; }\n',
};

describe('S10 Durable build pipeline: compile + smoke gate', () => {
  let db: PostgresDatabase;
  let artifactStore: ArtifactStore;
  let pipeline: BuildPipeline;

  let userId = '';
  let teamId = '';
  let tournamentId = '';
  let nextOrdinal = 1;
  const createdSubmissionIds: string[] = [];

  beforeAll(async () => {
    db = new PostgresDatabase();
    artifactStore = new ArtifactStore(db, path.join(buildRoot, 'sources'));
    pipeline = new BuildPipeline(db, artifactStore, { spoolDir: path.join(buildRoot, 'spool') });

    const user = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Build Bot Author', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`s10_author_${runId}`]
    );
    userId = user.rows[0].id;

    const course = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'S10 Build Course') RETURNING id`,
      [`S10_COURSE_${runId}`]
    );

    const team = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [course.rows[0].id, `Build Team ${runId}`, userId]
    );
    teamId = team.rows[0].id;

    const tournament = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state)
       VALUES ($1, 'Build Gate Tournament S10', 'SINGLE_ELIMINATION', 'REGISTRATION_OPEN')
       RETURNING id`,
      [course.rows[0].id]
    );
    tournamentId = tournament.rows[0].id;
  });

  afterAll(async () => {
    if (createdSubmissionIds.length > 0) {
      await db.query('DELETE FROM audit_events WHERE resource_type = $1 AND resource_id = ANY($2::text[])', [
        'SUBMISSION',
        createdSubmissionIds,
      ]);
    }
    if (tournamentId) {
      await db.query('DELETE FROM submissions WHERE tournament_id = $1', [tournamentId]);
      await db.query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
    }
    if (teamId) await db.query('DELETE FROM teams WHERE id = $1', [teamId]);
    if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]);
    if (tournamentId) await db.query('DELETE FROM courses WHERE code = $1', [`S10_COURSE_${runId}`]);
    await db.close();
  });

  /** Stores a source and inserts the receipt row intake would have written (status VALIDATING). */
  async function createReceipt(
    files: Record<string, string>,
    language: BotLanguage,
    entrypoint: string,
    status = 'VALIDATING'
  ): Promise<string> {
    const stored = await artifactStore.storeSource(createZip(files), language, entrypoint);
    const res = await db.query<{ id: string }>(
      `INSERT INTO submissions
         (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [tournamentId, teamId, userId, nextOrdinal++, stored.digest, language, entrypoint, status]
    );
    createdSubmissionIds.push(res.rows[0].id);
    return res.rows[0].id;
  }

  async function readSubmission(id: string): Promise<{ status: string; build_error: string | null; built_at: Date | null }> {
    const res = await db.query<{ status: string; build_error: string | null; built_at: Date | null }>(
      'SELECT status, build_error, built_at FROM submissions WHERE id = $1',
      [id]
    );
    return res.rows[0];
  }

  it('takes a valid TypeScript bot through COMPILING and SMOKE_TESTING to READY', async () => {
    const id = await createReceipt({ 'bot.ts': TS_BOT }, 'TYPESCRIPT', 'bot.ts');

    const outcome = await pipeline.buildSubmission(id);
    expect(outcome.status).toBe('READY');
    expect(outcome.reason).toBeUndefined();
    expect(outcome.sourceDigest).toHaveLength(64);
    expect(outcome.stderrDigest).toHaveLength(64);

    const row = await readSubmission(id);
    expect(row.status).toBe('READY');
    expect(row.build_error).toBeNull();
    expect(row.built_at).not.toBeNull();

    // The per-build spool directory never survives the build.
    expect(existsSync(path.join(buildRoot, 'spool', `submission-${id}`))).toBe(false);

    const audits = await db.query<{ action: string; details: { status: string; language: string } }>(
      `SELECT action, details FROM audit_events WHERE resource_type = 'SUBMISSION' AND resource_id = $1`,
      [id]
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].action).toBe('BUILD_ACCEPTED');
    expect(audits.rows[0].details).toEqual({ status: 'READY', language: 'TYPESCRIPT', stderrDigest: outcome.stderrDigest });

    // Idempotent: a replayed job reports the finished verdict without rebuilding.
    expect((await pipeline.buildSubmission(id)).status).toBe('READY');
    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE resource_type = 'SUBMISSION' AND resource_id = $1`,
      [id]
    );
    expect(after.rows[0].count).toBe('1');
  });

  it('rejects a TypeScript syntax error that only the smoke test can see', async () => {
    const id = await createReceipt({ 'bot.ts': TS_BROKEN }, 'TYPESCRIPT', 'bot.ts');

    const outcome = await pipeline.buildSubmission(id);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.reason).toContain('SMOKE_TEST_FAILED');

    const row = await readSubmission(id);
    expect(row.status).toBe('REJECTED');
    expect(row.build_error).toBe(outcome.reason);
    expect(row.built_at).not.toBeNull();

    const audits = await db.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE resource_type = 'SUBMISSION' AND resource_id = $1`,
      [id]
    );
    expect(audits.rows.map((a) => a.action)).toEqual(['BUILD_REJECTED']);

    // A finished rejection is reported back, never rebuilt.
    expect((await pipeline.buildSubmission(id)).status).toBe('REJECTED');
  });

  it('rejects a Python syntax error at compile time', async () => {
    const id = await createReceipt({ 'bot.py': 'def broken(:\n' }, 'PYTHON', 'bot.py');

    const outcome = await pipeline.buildSubmission(id);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.reason).toContain('PY_COMPILE_FAILED');

    const row = await readSubmission(id);
    expect(row.status).toBe('REJECTED');
    expect(row.build_error).toContain('PY_COMPILE_FAILED');
    expect(existsSync(path.join(buildRoot, 'spool', `submission-${id}`))).toBe(false);
  });

  it('rejects a bot that exits instead of answering INIT', async () => {
    const id = await createReceipt({ 'bot.py': PY_EXITS_IMMEDIATELY }, 'PYTHON', 'bot.py');

    const outcome = await pipeline.buildSubmission(id);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.reason).toContain('SMOKE_TEST_FAILED');
    expect((await readSubmission(id)).status).toBe('REJECTED');
  });

  it('resolves an unknown submission id with a 404-shaped error', async () => {
    await expect(pipeline.buildSubmission('00000000-0000-4000-8000-000000000000')).rejects.toThrow(BuildPipelineError);
  });

  it.skipIf(!hasGpp)('compiles a C++ bot to READY and rejects a C++ syntax error', async () => {
    const good = await createReceipt({ 'bot.cpp': CPP_BOT }, 'CPP', 'bot.cpp');
    const goodOutcome = await pipeline.buildSubmission(good);
    expect(goodOutcome.status).toBe('READY');
    expect((await readSubmission(good)).status).toBe('READY');

    const bad = await createReceipt({ 'bot.cpp': CPP_BROKEN }, 'CPP', 'bot.cpp');
    const badOutcome = await pipeline.buildSubmission(bad);
    expect(badOutcome.status).toBe('REJECTED');
    expect(badOutcome.reason).toContain('CPP_COMPILE_FAILED');
    expect((await readSubmission(bad)).status).toBe('REJECTED');
  });

  it('rejects a receipt whose stored artifact does not hash to the recorded digest', async () => {
    const id = await createReceipt({ 'bot.py': PY_EXITS_IMMEDIATELY }, 'PYTHON', 'bot.py');

    // A source row whose key disagrees with the bytes it points at: the materializer re-hashes
    // the artifact and must refuse to build it rather than run something unverified.
    const aliasDigest = `${'0'.repeat(56)}${runId.slice(-8)}`;
    await db.query(
      `INSERT INTO submission_sources (digest, storage_path, zip_bytes, expanded_bytes, file_count, manifest)
       SELECT $1, storage_path, zip_bytes, expanded_bytes, file_count, manifest
       FROM submission_sources WHERE digest = (SELECT source_digest FROM submissions WHERE id = $2)`,
      [aliasDigest, id]
    );
    await db.query('UPDATE submissions SET source_digest = $2 WHERE id = $1', [id, aliasDigest]);

    const outcome = await pipeline.buildSubmission(id);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.reason).toContain('SOURCE_DIGEST_MISMATCH');
    expect((await readSubmission(id)).status).toBe('REJECTED');
  });

  it('builds a multi-file project in each of the three languages', async () => {
    const typescript = await createReceipt(TS_MULTI, 'TYPESCRIPT', 'bot.ts');
    expect(await pipeline.buildSubmission(typescript)).toMatchObject({ status: 'READY' });

    const python = await createReceipt(PY_MULTI, 'PYTHON', 'bot.py');
    expect(await pipeline.buildSubmission(python)).toMatchObject({ status: 'READY' });

    if (hasGpp) {
      const cpp = await createReceipt(CPP_MULTI, 'CPP', 'bot.cpp');
      expect(await pipeline.buildSubmission(cpp)).toMatchObject({ status: 'READY' });
    }
  });
});
