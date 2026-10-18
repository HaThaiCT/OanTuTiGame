import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as zlib from 'node:zlib';
import type { Actor, CommandContext } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { SubmissionService, SubmissionError } from '../src/submissions/service.js';
import { PrivateTestService, TestError } from '../src/submissions/private-test-service.js';

describe('S11: Submission & Test Integration (T3b)', () => {
  let db: PostgresDatabase;
  let artifactStore: ArtifactStore;
  let submissionService: SubmissionService;
  let testService: PrivateTestService;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  let adminActor: Actor;
  let studentActorA: Actor;
  let studentActorB: Actor;
  let adminCtx: CommandContext;
  let studentCtxA: CommandContext;

  let testCourseId: string;
  let testTournamentId: string;
  let testFinalizedTourneyId: string;
  let testTeamAId: string;
  let testTeamBId: string;
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

  beforeAll(async () => {
    db = new PostgresDatabase();
    artifactStore = new ArtifactStore(db, `/tmp/oantuti-test-submissions-${runId}`);
    submissionService = new SubmissionService(db, artifactStore);
    testService = new PrivateTestService(db, artifactStore);

    // Bootstrap Users
    const uAdmin = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Admin User', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id`,
      [`s11_admin_${runId}`]
    );

    const uStudentA = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Student A', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`s11_student_a_${runId}`]
    );

    const uStudentB = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Student B', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`s11_student_b_${runId}`]
    );

    // Course
    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'T3b Integration Course') RETURNING id`,
      [`S11_COURSE_${runId}`]
    );
    testCourseId = courseRes.rows[0].id;

    // Teams
    const tA = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Team A ${runId}`, uStudentA.rows[0].id]
    );
    testTeamAId = tA.rows[0].id;

    const tB = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Team B ${runId}`, uStudentB.rows[0].id]
    );
    testTeamBId = tB.rows[0].id;

    adminActor = {
      userId: uAdmin.rows[0].id,
      role: 'ADMIN',
      username: `s11_admin_${runId}`,
      teamIds: [],
      scope: 'FULL',
    };

    studentActorA = {
      userId: uStudentA.rows[0].id,
      role: 'STUDENT',
      username: `s11_student_a_${runId}`,
      teamIds: [testTeamAId],
      scope: 'FULL',
    };

    studentActorB = {
      userId: uStudentB.rows[0].id,
      role: 'STUDENT',
      username: `s11_student_b_${runId}`,
      teamIds: [testTeamBId],
      scope: 'FULL',
    };

    adminCtx = { actor: adminActor, requestId: randomUUID() };
    studentCtxA = { actor: studentActorA, requestId: randomUUID() };

    // Active Tournament (REGISTRATION_OPEN)
    const tourneyRes = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state)
       VALUES ($1, 'Active Tournament S11', 'SINGLE_ELIMINATION', 'REGISTRATION_OPEN')
       RETURNING id`,
      [testCourseId]
    );
    testTournamentId = tourneyRes.rows[0].id;

    // Finalized Tournament (FINALIZED)
    const finRes = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, finalized_at)
       VALUES ($1, 'Historical Finalized Tournament S11', 'SINGLE_ELIMINATION', 'FINALIZED', clock_timestamp())
       RETURNING id`,
      [testCourseId]
    );
    testFinalizedTourneyId = finRes.rows[0].id;

    // Enroll Team A & Team B in active tournament
    await db.query(
      `INSERT INTO tournament_admissions (tournament_id, team_id, admitted_by_user_id, admission_type)
       VALUES ($1, $2, $3, 'DIRECT_ENROLLMENT'),
              ($1, $4, $3, 'DIRECT_ENROLLMENT')`,
      [testTournamentId, testTeamAId, adminActor.userId, testTeamBId]
    );
  });

  afterAll(async () => {
    await db.close();
  });

  describe('1. Three Language Multi-File Source Submissions', () => {
    it('accepts multi-file Python submission and assigns receipt ordinal', async () => {
      const zip = await createZip({
        'main.py': '# Python entrypoint\nimport helper\nprint("READY")',
        'helper.py': '# Python helper module\ndef get_move(): pass',
      });

      const receipt = await submissionService.submit(
        testTournamentId,
        testTeamAId,
        { language: 'PYTHON', entrypoint: 'main.py', zipBuffer: zip },
        studentActorA
      );

      expect(receipt.data.receiptOrdinal).toBe(1);
      expect(receipt.data.submissionId).toBeDefined();

      // Update to READY for subsequent candidate checks
      await db.query("UPDATE submissions SET status = 'READY' WHERE id = $1", [receipt.data.submissionId]);

      const candidate = await submissionService.getLatestCandidate(testTournamentId, testTeamAId, studentActorA);
      expect(candidate).not.toBeNull();
      expect(candidate?.receiptOrdinal).toBe(1);
      expect(candidate?.language).toBe('PYTHON');
    });

    it('accepts multi-file TypeScript submission and increments receipt ordinal', async () => {
      const zip = await createZip({
        'bot.ts': '// TypeScript entrypoint\nimport { strategy } from "./strategy.js";',
        'strategy.ts': 'export const strategy = "aggressive";',
      });

      const receipt = await submissionService.submit(
        testTournamentId,
        testTeamAId,
        { language: 'TYPESCRIPT', entrypoint: 'bot.ts', zipBuffer: zip },
        studentActorA
      );

      expect(receipt.data.receiptOrdinal).toBe(2);
      await db.query("UPDATE submissions SET status = 'READY' WHERE id = $1", [receipt.data.submissionId]);

      const candidate = await submissionService.getLatestCandidate(testTournamentId, testTeamAId, studentActorA);
      expect(candidate?.receiptOrdinal).toBe(2);
      expect(candidate?.language).toBe('TYPESCRIPT');
    });

    it('accepts multi-file C++20 submission and increments receipt ordinal', async () => {
      const zip = await createZip({
        'main.cpp': '#include "bot.hpp"\nint main() { return 0; }',
        'bot.hpp': '#pragma once\nclass Bot {};',
      });

      const receipt = await submissionService.submit(
        testTournamentId,
        testTeamAId,
        { language: 'CPP', entrypoint: 'main.cpp', zipBuffer: zip },
        studentActorA
      );

      expect(receipt.data.receiptOrdinal).toBe(3);
      await db.query("UPDATE submissions SET status = 'READY' WHERE id = $1", [receipt.data.submissionId]);

      const candidate = await submissionService.getLatestCandidate(testTournamentId, testTeamAId, studentActorA);
      expect(candidate?.receiptOrdinal).toBe(3);
      expect(candidate?.language).toBe('CPP');
    });
  });

  describe('2. Cutoff Enforcement & New Failure Fallback', () => {
    it('retains previous candidate if a newer submission fails compilation', async () => {
      // Team A submits ordinal 4 which gets REJECTED (compile error)
      const zip = await createZip({
        'broken.py': 'syntax error !!! invalid python code',
      });

      const receipt = await submissionService.submit(
        testTournamentId,
        testTeamAId,
        { language: 'PYTHON', entrypoint: 'broken.py', zipBuffer: zip },
        studentActorA
      );

      expect(receipt.data.receiptOrdinal).toBe(4);
      await db.query("UPDATE submissions SET status = 'REJECTED', reject_reason = 'COMPILE_ERROR' WHERE id = $1", [
        receipt.data.submissionId,
      ]);

      // Previous valid candidate (ordinal 3) remains the active candidate!
      const candidate = await submissionService.getLatestCandidate(testTournamentId, testTeamAId, studentActorA);
      expect(candidate?.receiptOrdinal).toBe(3);
      expect(candidate?.status).toBe('READY');
    });

    it('strictly denies official submissions after tournament cutoff or lock', async () => {
      // Simulate registration deadline passed
      await db.query(
        "UPDATE tournaments SET registration_closes_at = clock_timestamp() - INTERVAL '10 minutes' WHERE id = $1",
        [testTournamentId]
      );

      const zip = await createZip({ 'main.py': 'print("late")' });

      await expect(
        submissionService.submit(
          testTournamentId,
          testTeamAId,
          { language: 'PYTHON', entrypoint: 'main.py', zipBuffer: zip },
          studentActorA
        )
      ).rejects.toThrow(SubmissionError);

      // Restore deadline
      await db.query("UPDATE tournaments SET registration_closes_at = NULL WHERE id = $1", [testTournamentId]);
    });
  });

  describe('3. Private TEST Invariant Protection', () => {
    it('allows private TEST even in a FINALIZED tournament where official submissions are locked', async () => {
      const zip = await createZip({
        'test_bot.py': '# Test bot script\nprint("TEST")',
      });

      // Submit private test in FINALIZED tournament
      const testReceipt = await testService.createTest(
        {
          tournamentId: testFinalizedTourneyId,
          teamId: testTeamAId,
          language: 'PYTHON',
          entrypoint: 'test_bot.py',
          sourceZipBuffer: zip,
          opponentType: 'BASELINE_GREEDY',
        },
        studentCtxA
      );

      expect(testReceipt.data.status).toBe('COMPLETED');
      expect(testReceipt.data.testId).toBeDefined();

      // Verify ZERO mutation of submissions table or receipt ordinal!
      const subCount = await db.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM submissions WHERE tournament_id = $1',
        [testFinalizedTourneyId]
      );
      expect(parseInt(subCount.rows[0].count, 10)).toBe(0);

      // Verify ZERO rating events created
      const ratingCount = await db.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM rating_events WHERE tournament_id = $1',
        [testFinalizedTourneyId]
      );
      expect(parseInt(ratingCount.rows[0].count, 10)).toBe(0);
    });

    it('enforces privacy: team B student cannot view private test results of team A', async () => {
      const zip = await createZip({ 'secret.py': '# Secret private code' });

      const test = await testService.createTest(
        {
          tournamentId: testTournamentId,
          teamId: testTeamAId,
          language: 'PYTHON',
          entrypoint: 'secret.py',
          sourceZipBuffer: zip,
          opponentType: 'BASELINE_RANDOM',
        },
        studentCtxA
      );

      // Team A can view results and logs
      const resultA = await testService.getTestResult(test.data.testId, studentActorA);
      expect(resultA.testId).toBe(test.data.testId);
      expect(resultA.status).toBe('COMPLETED');
      expect(resultA.buildLogs).toBeDefined();

      // Team B is denied!
      await expect(
        testService.getTestResult(test.data.testId, studentActorB)
      ).rejects.toThrow(TestError);

      // Admin CAN view
      const resultAdmin = await testService.getTestResult(test.data.testId, adminActor);
      expect(resultAdmin.testId).toBe(test.data.testId);
    });

    it('enforces concurrent quota limit (max 2 pending per team)', async () => {
      // Insert 2 fake pending tests in QUEUED status
      await db.query(
        `INSERT INTO submission_sources (digest, storage_path, zip_bytes, expanded_bytes, file_count, manifest)
         VALUES ('digest_quota_test', '/tmp/fake_q.zip', 10, 20, 1, '[]'::jsonb)
         ON CONFLICT (digest) DO NOTHING`
      );
      await db.query(
        `INSERT INTO test_snapshots (tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status)
         VALUES ($1, $2, $3, 'digest_quota_test', 'PYTHON', 'main.py', 'QUEUED'),
                ($1, $2, $3, 'digest_quota_test', 'PYTHON', 'main.py', 'RUNNING')`,
        [testTournamentId, testTeamBId, studentActorB.userId]
      );

      const zip = await createZip({ 'test.py': 'pass' });

      // 3rd attempt must be rejected with 429
      await expect(
        testService.createTest(
          {
            tournamentId: testTournamentId,
            teamId: testTeamBId,
            language: 'PYTHON',
            entrypoint: 'test.py',
            sourceZipBuffer: zip,
            opponentType: 'BASELINE_GREEDY',
          },
          { actor: studentActorB, requestId: randomUUID() }
        )
      ).rejects.toThrow(TestError);
    });
  });
});
