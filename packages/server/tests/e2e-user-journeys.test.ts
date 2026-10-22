import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Database } from '../src/persistence/db.js';
import { hashPassword, hashToken } from '../src/identity/crypto.js';
import { IdentityService } from '../src/identity/service.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { ContentService } from '../src/content/service.js';
import { registerContentRoutes } from '../src/content/routes.js';
import { TeamService } from '../src/teams/service.js';
import { registerTeamRoutes } from '../src/teams/routes.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { TournamentRegistrationService } from '../src/tournaments/registration-service.js';
import { registerAdmissionRoutes, registerRegistrationRoutes } from '../src/tournaments/routes.js';
import { createZip } from './helpers/zip.js';
import type { Actor } from '@oantuti/protocol';

describe('End-to-End User Journeys — Guest, Student, Admin & Content', () => {
  let app: FastifyInstance;
  let db: Database;
  let artifactStore: ArtifactStore;
  let contentService: ContentService;
  let identityService: IdentityService;
  let teamService: TeamService;
  let registrationService: TournamentRegistrationService;
  let tempDir: string;

  let adminActor: Actor;
  let adminToken: string;
  let studentActor: Actor;
  let studentToken: string;
  let courseId: string;
  let tournamentId: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'oantuti-journey-test-'));
    db = new Database();
    artifactStore = new ArtifactStore(db, path.join(tempDir, 'sources'));
    contentService = new ContentService(db, artifactStore);
    identityService = new IdentityService(db, 'ONLINE', { localDemoSkipEmailVerification: true });
    teamService = new TeamService(db, 'ONLINE');
    registrationService = new TournamentRegistrationService(db, 'ONLINE');

    const runId = Date.now().toString(36);

    // 1. Admin setup
    let admin = (await db.query<{ id: string }>("SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
    if (!admin) {
      const adminRes = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, 'Journey Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id`,
        [`journey_admin_${runId}`]
      );
      admin = adminRes.rows[0];
    }
    const adminId = admin.id;
    adminActor = { userId: adminId, role: 'ADMIN', scope: 'FULL' };
    adminToken = randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, scope, expires_at)
       VALUES ($1, $2, 'FULL', clock_timestamp() + interval '1 hour')`,
      [adminId, hashToken(adminToken)]
    );

    // 2. Verified Student setup
    const studentRes = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, email, email_verified_at, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Journey Student', $2, clock_timestamp(), 'hash', 'STUDENT', 'SELF_REGISTER', FALSE) RETURNING id`,
      [`journey_student_${runId}`, `student_${runId}@uet.vnu.edu.vn`]
    );
    const studentId = studentRes.rows[0].id;
    studentActor = { userId: studentId, role: 'STUDENT', scope: 'FULL' };
    studentToken = randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, scope, expires_at)
       VALUES ($1, $2, 'FULL', clock_timestamp() + interval '1 hour')`,
      [studentId, hashToken(studentToken)]
    );

    // 3. Course and Tournament setup
    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Journey Course') RETURNING id`,
      [`JOURNEY_${runId.toUpperCase()}`]
    );
    courseId = courseRes.rows[0].id;

    const tourneyRes = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, rules_revision, max_teams, registration_opens_at, registration_closes_at)
       VALUES ($1, 'Journey Tournament', 'ROUND_ROBIN', 'REGISTRATION_OPEN', 'ArenaGameplay/v2', 16, clock_timestamp() - interval '1 hour', clock_timestamp() + interval '10 days')
       RETURNING id`,
      [courseId]
    );
    tournamentId = tourneyRes.rows[0].id;

    app = Fastify({ logger: false });
    registerContentRoutes(app, contentService, identityService);
    registerTeamRoutes(app, teamService, identityService);
    registerRegistrationRoutes(app, registrationService, identityService);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('Journey 1: Guest reads news stream and downloads starter bot', async () => {
    // 1. Guest views news
    const newsRes = await app.inject({ method: 'GET', url: '/api/v2/news' });
    expect(newsRes.statusCode).toBe(200);

    // 2. Guest views starter bots
    const botsRes = await app.inject({ method: 'GET', url: '/api/v2/starter-bots' });
    expect(botsRes.statusCode).toBe(200);
  });

  it('Journey 2: Student creates team for tournament and requests registration', async () => {
    // 1. Create team
    const teamRes = await app.inject({
      method: 'POST',
      url: '/api/v2/me/teams',
      headers: { cookie: `oantuti_session=${studentToken}` },
      payload: {
        tournamentId,
        name: `Team Journey ${Date.now()}`,
      },
    });
    expect(teamRes.statusCode).toBe(201);
    const team = JSON.parse(teamRes.body);
    expect(team.captainUserId).toBe(studentActor.userId);

    // 2. Request tournament registration
    const regRes = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/registrations`,
      headers: { cookie: `oantuti_session=${studentToken}` },
      payload: { teamId: team.id },
    });
    expect(regRes.statusCode).toBe(201);
    const registration = JSON.parse(regRes.body);
    expect(registration.status).toBe('PENDING');

    // 3. Admin reviews and approves registration
    const reviewRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/registrations/${registration.id}/review`,
      headers: { cookie: `oantuti_session=${adminToken}` },
      payload: {
        decision: 'APPROVE',
        expectedVersion: registration.version,
      },
    });
    expect(reviewRes.statusCode).toBe(200);
    expect(JSON.parse(reviewRes.body).status).toBe('APPROVED');
  });

  it('Journey 3: Admin manages editorial news and uploads starter bot', async () => {
    // 1. Create & publish news
    const slug = `journey-news-${Date.now()}`;
    const newsRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/news',
      headers: { cookie: `oantuti_session=${adminToken}` },
      payload: {
        title: 'Thông báo giải đấu Journey Cup',
        slug,
        summary: 'Tin tức mới về giải đấu.',
        content: '# Journey Cup\n\nNội dung bài viết kiểm thử luồng người dùng.',
        publishNow: true,
      },
    });
    expect(newsRes.statusCode).toBe(201);
    expect(JSON.parse(newsRes.body).post.state).toBe('PUBLISHED');

    // 2. Upload starter bot
    const botSlug = `journey-bot-${Date.now()}`;
    const zipBase64 = createZip({
      'main.py': '#!/usr/bin/env python3\nprint("READY")\n',
    }).toString('base64');

    const botRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/starter-bots',
      headers: { cookie: `oantuti_session=${adminToken}` },
      payload: {
        name: 'Python Journey Starter',
        slug: botSlug,
        language: 'PYTHON',
        entrypoint: 'main.py',
        description: 'Starter bot test',
        zipBase64,
      },
    });
    expect(botRes.statusCode).toBe(201);

    // 3. Download the uploaded starter bot
    const dlRes = await app.inject({
      method: 'GET',
      url: `/api/v2/starter-bots/${botSlug}/download`,
    });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers['content-type']).toBe('application/zip');
  });
});
