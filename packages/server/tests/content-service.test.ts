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
  /** Users this suite inserted; a shared sequential database must not keep their rows around. */
  const ownedUserIds: string[] = [];

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
      ownedUserIds.push(admin.id);
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
    ownedUserIds.push(studentId);
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
    // The file runs before suites that reset shared tables wholesale (submission-quotas), so its
    // news rows would otherwise survive under a user another suite's `DELETE FROM users` must
    // remove. Only rows this suite inserted are retired — later files keep what was already
    // there. The app-role grant set (append-only audit_events) may refuse some deletes in a
    // restricted environment, so each statement fails soft instead of losing the whole sweep.
    try {
      const retired = (await db.query(
        `DELETE FROM news_posts WHERE author_user_id = ANY($1::uuid[])`,
        [ownedUserIds]
      )).rowCount ?? 0;
      for (const statement of [
        [`DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[])`, 'audit events'],
        [`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, 'sessions'],
        [`DELETE FROM users WHERE id = ANY($1::uuid[])`, 'users'],
      ] as const) {
        try {
          await db.query(statement[0], [ownedUserIds]);
        } catch (error) {
          console.warn(`[content-service] could not retire own ${statement[1]}: ${(error as Error).message}`);
        }
      }
      if (retired === 0 && ownedUserIds.length > 0) {
        console.warn('[content-service] no news rows were retired; shared database may keep fixture users');
      }
    } catch (error) {
      console.warn(`[content-service] shared rows left behind: ${(error as Error).message}`);
    }
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

  it('treats a garbage public news ?limit as the default page instead of a server error', async () => {
    // Seed enough published posts that the default clamp (10, max 50) is observable.
    const stamp = Date.now().toString(36);
    for (let index = 0; index < 3; index += 1) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v2/organizer/news',
        headers: { cookie: `oantuti_session=${adminToken}` },
        payload: {
          title: `Bản tin giới hạn ${index} ${stamp}`,
          slug: `limit-news-${index}-${stamp}`,
          summary: `Tóm tắt bản tin ${index}`,
          content: 'Nội dung bài viết.',
          publishNow: true,
        },
      });
      expect(created.statusCode).toBe(201);
    }

    const nanRes = await app.inject({ method: 'GET', url: '/api/v2/news?limit=abc' });
    expect(nanRes.statusCode).toBe(200);
    const nanBody = JSON.parse(nanRes.body);
    expect(nanBody.posts).toBeInstanceOf(Array);
    // Default page size, not an unbounded or crashing query.
    expect(nanBody.posts.length).toBeLessThanOrEqual(10);

    const defaultRes = await app.inject({ method: 'GET', url: '/api/v2/news' });
    expect(defaultRes.statusCode).toBe(200);
    expect(JSON.parse(defaultRes.body).posts.length).toBe(nanBody.posts.length);

    // A numeric limit still narrows exactly as before.
    const oneRes = await app.inject({ method: 'GET', url: '/api/v2/news?limit=1' });
    expect(oneRes.statusCode).toBe(200);
    expect(JSON.parse(oneRes.body).posts).toHaveLength(1);

    const absurdRes = await app.inject({ method: 'GET', url: '/api/v2/news?limit=99999' });
    expect(absurdRes.statusCode).toBe(200);

    const zeroRes = await app.inject({ method: 'GET', url: '/api/v2/news?limit=0' });
    expect(zeroRes.statusCode).toBe(200);
    expect(JSON.parse(zeroRes.body).posts).toHaveLength(1);
  });

  it('coerces a PUT news update without a usable JSON body instead of crashing', async () => {
    const slug = `put-coerce-${Date.now().toString(36)}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/news',
      headers: { cookie: `oantuti_session=${adminToken}` },
      payload: {
        title: 'Bản tin cơ bản',
        slug,
        summary: 'Bản tóm tắt gốc',
        content: 'Nội dung gốc',
      },
    });
    expect(created.statusCode).toBe(201);
    const postId: string = JSON.parse(created.body).post.id;

    // No body at all: the update lands as a no-op touch, not a 500 TypeError.
    const emptyRes = await app.inject({
      method: 'PUT',
      url: `/api/v2/organizer/news/${postId}`,
      headers: { cookie: `oantuti_session=${adminToken}` },
    });
    expect(emptyRes.statusCode).toBe(200);
    expect(JSON.parse(emptyRes.body).post.title).toBe('Bản tin cơ bản');

    // Non-string fields cannot reach the service as values: they are dropped, not dereferenced.
    const junkRes = await app.inject({
      method: 'PUT',
      url: `/api/v2/organizer/news/${postId}`,
      headers: { cookie: `oantuti_session=${adminToken}` },
      payload: { title: null, summary: 42, content: { nested: true } },
    });
    expect(junkRes.statusCode).toBe(200);
    const kept = JSON.parse(junkRes.body).post;
    expect(kept.title).toBe('Bản tin cơ bản');
    expect(kept.summary).toBe('Bản tóm tắt gốc');
    expect(kept.content).toBe('Nội dung gốc');

    // Real string edits still go through with the same coercion path.
    const editRes = await app.inject({
      method: 'PUT',
      url: `/api/v2/organizer/news/${postId}`,
      headers: { cookie: `oantuti_session=${adminToken}` },
      payload: { title: 'Bản tin đã sửa' },
    });
    expect(editRes.statusCode).toBe(200);
    expect(JSON.parse(editRes.body).post.title).toBe('Bản tin đã sửa');
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
