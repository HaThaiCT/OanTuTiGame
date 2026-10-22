import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Database } from '../src/persistence/db.js';
import { hashPassword, hashToken } from '../src/identity/crypto.js';
import { IdentityService } from '../src/identity/service.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { ContentService } from '../src/content/service.js';
import { registerContentRoutes } from '../src/content/routes.js';
import { createZip } from './helpers/zip.js';
import type { Actor } from '@oantuti/protocol';

describe('S15 ContentService & Routes — News & Starter Bots', () => {
  let app: FastifyInstance;
  let db: Database;
  let artifactStore: ArtifactStore;
  let contentService: ContentService;
  let identityService: IdentityService;
  let tempDir: string;
  let adminActor: Actor;
  let adminToken: string;
  let studentActor: Actor;
  let studentToken: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'oantuti-content-test-'));
    db = new Database();
    artifactStore = new ArtifactStore(db, path.join(tempDir, 'sources'));
    contentService = new ContentService(db, artifactStore);
    identityService = new IdentityService(db);

    const runId = Date.now().toString(36);
    let admin = (await db.query<{ id: string }>("SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1")).rows[0];
    if (!admin) {
      const adminRes = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, 'Content Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id`,
        [`content_admin_${runId}`]
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

    const studentRes = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Content Student', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`content_student_${runId}`]
    );
    const studentId = studentRes.rows[0].id;
    studentActor = { userId: studentId, role: 'STUDENT', scope: 'FULL' };
    studentToken = randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, scope, expires_at)
       VALUES ($1, $2, 'FULL', clock_timestamp() + interval '1 hour')`,
      [studentId, hashToken(studentToken)]
    );

    app = Fastify({ logger: false });
    registerContentRoutes(app, contentService, identityService);
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

  it('manages news post lifecycle: create draft, publish, view publicly, and archive', async () => {
    const slug = `tournament-announcement-${Date.now()}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/news',
      headers: { cookie: `oantuti_session=${adminToken}` },
      payload: {
        title: 'Mở đăng ký giải đấu Mùa Thu 2026',
        slug,
        summary: 'Ban tổ chức thông báo chính thức mở đăng ký tham dự giải đấu.',
        content: '# Thông báo\n\nCác đội có thể tạo đội và gửi đăng ký từ hôm nay.',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(created.post.state).toBe('DRAFT');
    expect(created.post.title).toBe('Mở đăng ký giải đấu Mùa Thu 2026');

    // Guest public list should not include draft
    const publicBefore = await app.inject({ method: 'GET', url: '/api/v2/news' });
    expect(publicBefore.statusCode).toBe(200);
    const postsBefore = JSON.parse(publicBefore.body).posts;
    expect(postsBefore.some((p: { slug: string }) => p.slug === slug)).toBe(false);

    // Publish post
    const pubRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/news/${created.post.id}/publish`,
      headers: { cookie: `oantuti_session=${adminToken}` },
    });
    expect(pubRes.statusCode).toBe(200);
    expect(JSON.parse(pubRes.body).post.state).toBe('PUBLISHED');

    // Guest public list now includes published post
    const publicAfter = await app.inject({ method: 'GET', url: '/api/v2/news' });
    expect(publicAfter.statusCode).toBe(200);
    const postsAfter = JSON.parse(publicAfter.body).posts;
    expect(postsAfter.some((p: { slug: string }) => p.slug === slug)).toBe(true);

    // Get single published post by slug
    const singleRes = await app.inject({ method: 'GET', url: `/api/v2/news/${slug}` });
    expect(singleRes.statusCode).toBe(200);
    expect(JSON.parse(singleRes.body).post.title).toBe('Mở đăng ký giải đấu Mùa Thu 2026');

    // Archive post
    const archiveRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/news/${created.post.id}/archive`,
      headers: { cookie: `oantuti_session=${adminToken}` },
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(JSON.parse(archiveRes.body).post.state).toBe('ARCHIVED');
  });

  it('rejects unauthorized students from news management endpoints', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/news',
      headers: { cookie: `oantuti_session=${studentToken}` },
      payload: {
        title: 'Hacked news',
        slug: 'hacked-news',
        summary: 'summary',
        content: 'content',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('uploads, downloads, and archives starter bot templates', async () => {
    const slug = `py-sample-bot-${Date.now()}`;
    const zipBase64 = createZip({
      'main.py': '#!/usr/bin/env python3\nprint("READY")\n',
    }).toString('base64');

    const uploadRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/starter-bots',
      headers: { cookie: `oantuti_session=${adminToken}` },
      payload: {
        name: 'Python Greedy Starter',
        slug,
        language: 'PYTHON',
        entrypoint: 'main.py',
        description: 'Bot mẫu thuật toán tham lam.',
        zipBase64,
      },
    });

    expect(uploadRes.statusCode).toBe(201);
    const uploaded = JSON.parse(uploadRes.body);
    expect(uploaded.template.name).toBe('Python Greedy Starter');
    expect(uploaded.template.language).toBe('PYTHON');

    // Public list returns the template
    const listRes = await app.inject({ method: 'GET', url: '/api/v2/starter-bots' });
    expect(listRes.statusCode).toBe(200);
    const templates = JSON.parse(listRes.body).templates;
    expect(templates.some((t: { slug: string }) => t.slug === slug)).toBe(true);

    // Download returns the ZIP buffer
    const dlRes = await app.inject({ method: 'GET', url: `/api/v2/starter-bots/${slug}/download` });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers['content-type']).toBe('application/zip');
    expect(dlRes.rawPayload.length).toBeGreaterThan(0);

    // Archive template
    const archRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/starter-bots/${uploaded.template.id}/archive`,
      headers: { cookie: `oantuti_session=${adminToken}` },
    });
    expect(archRes.statusCode).toBe(200);
    expect(JSON.parse(archRes.body).archived).toBe(true);
  });
});
