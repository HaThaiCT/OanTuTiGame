import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Database } from '../persistence/db.js';
import type { ArtifactStore } from '../submissions/artifact-store.js';
import type {
  Actor,
  AdminNewsPostDto,
  BotLanguage,
  NewsPostDto,
  StarterBotTemplateDto,
  UUID,
} from '@oantuti/protocol';

export class ContentError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = 'CONTENT_ERROR'
  ) {
    super(message);
    this.name = 'ContentError';
  }
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function writeStoredZip(entries: readonly { name: string; bytes: Buffer }[]): Buffer {
  const fileHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.bytes);
    const size = entry.bytes.length;

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Min version (2.0)
    localHeader.writeUInt16LE(0, 6); // Flags
    localHeader.writeUInt16LE(0, 8); // Compression (0 = stored)
    localHeader.writeUInt16LE(0, 10); // Time
    localHeader.writeUInt16LE(0, 12); // Date
    localHeader.writeUInt32LE(crc, 14); // CRC32
    localHeader.writeUInt32LE(size, 18); // Compressed size
    localHeader.writeUInt32LE(size, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBytes.copy(localHeader, 30);

    fileHeaders.push(localHeader, entry.bytes);

    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed
    centralHeader.writeUInt16LE(0, 8); // Flags
    centralHeader.writeUInt16LE(0, 10); // Compression
    centralHeader.writeUInt16LE(0, 12); // Time
    centralHeader.writeUInt16LE(0, 14); // Date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra field len
    centralHeader.writeUInt16LE(0, 32); // Comment len
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // External file attributes (regular file)
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header
    nameBytes.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += localHeader.length + entry.bytes.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const c of centralHeaders) centralDirSize += c.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Disk number
  eocd.writeUInt16LE(0, 6); // Disk with central directory
  eocd.writeUInt16LE(entries.length, 8); // Entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // Total entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // Comment len

  return Buffer.concat([...fileHeaders, ...centralHeaders, eocd]);
}

function crc32(buffer: Buffer): number {
  let crc = 0 ^ -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

export class ContentService {
  constructor(
    private readonly db: Database,
    private readonly artifactStore: ArtifactStore
  ) {}

  private requireAdmin(actor: Actor): void {
    if (actor.role !== 'ADMIN' || actor.scope !== 'FULL') {
      throw new ContentError(403, 'Administrator access required', 'FORBIDDEN');
    }
  }

  /* ---------------------------------------------------------------------------------------------
   * News Management
   * ------------------------------------------------------------------------------------------- */

  async listPublishedNews(limit = 10): Promise<{ posts: NewsPostDto[] }> {
    const safeLimit = Math.max(1, Math.min(50, limit));
    const result = await this.db.query<{
      id: string;
      slug: string;
      title: string;
      summary: string;
      content: string;
      published_at: Date;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, slug, title, summary, content, published_at, created_at, updated_at
       FROM news_posts
       WHERE state = 'PUBLISHED'
       ORDER BY published_at DESC, id DESC
       LIMIT $1`,
      [safeLimit]
    );

    return {
      posts: result.rows.map((row) => ({
        id: row.id as UUID,
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        content: row.content,
        publishedAt: row.published_at.toISOString(),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
    };
  }

  async getPublishedPost(slug: string): Promise<NewsPostDto | null> {
    const result = await this.db.query<{
      id: string;
      slug: string;
      title: string;
      summary: string;
      content: string;
      published_at: Date;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, slug, title, summary, content, published_at, created_at, updated_at
       FROM news_posts
       WHERE slug = $1 AND state = 'PUBLISHED'`,
      [slug]
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id as UUID,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      content: row.content,
      publishedAt: row.published_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async adminListNews(actor: Actor): Promise<{ posts: AdminNewsPostDto[] }> {
    this.requireAdmin(actor);
    const result = await this.db.query<{
      id: string;
      slug: string;
      title: string;
      summary: string;
      content: string;
      state: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
      author_user_id: string;
      author_display_name: string;
      published_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT p.id, p.slug, p.title, p.summary, p.content, p.state, p.author_user_id,
              u.display_name AS author_display_name, p.published_at, p.created_at, p.updated_at
       FROM news_posts p
       JOIN users u ON u.id = p.author_user_id
       ORDER BY p.updated_at DESC`
    );

    return {
      posts: result.rows.map((row) => ({
        id: row.id as UUID,
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        content: row.content,
        state: row.state,
        authorUserId: row.author_user_id as UUID,
        authorDisplayName: row.author_display_name,
        publishedAt: row.published_at ? row.published_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
    };
  }

  async adminCreateNews(
    input: { title: string; slug: string; summary: string; content: string; publishNow?: boolean },
    actor: Actor
  ): Promise<AdminNewsPostDto> {
    this.requireAdmin(actor);
    const title = input.title?.trim() ?? '';
    const slug = (input.slug?.trim() || title.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-+|-+$/g, '');
    const summary = input.summary?.trim() ?? '';
    const content = input.content?.trim() ?? '';

    if (!title || title.length > 150) throw new ContentError(400, 'Title required (max 150 chars)', 'INVALID_TITLE');
    if (!slug || !SLUG_PATTERN.test(slug)) throw new ContentError(400, 'Slug must be valid kebab-case', 'INVALID_SLUG');
    if (!summary || summary.length > 500) throw new ContentError(400, 'Summary required (max 500 chars)', 'INVALID_SUMMARY');
    if (!content || content.length > 50000) throw new ContentError(400, 'Content required (max 50000 chars)', 'INVALID_CONTENT');

    const state = input.publishNow ? 'PUBLISHED' : 'DRAFT';
    const publishedAt = input.publishNow ? new Date() : null;

    try {
      const result = await this.db.query<{
        id: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO news_posts (slug, title, summary, content, state, author_user_id, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, created_at, updated_at`,
        [slug, title, summary, content, state, actor.userId, publishedAt]
      );
      const row = result.rows[0];
      return {
        id: row.id as UUID,
        slug,
        title,
        summary,
        content,
        state,
        authorUserId: actor.userId,
        publishedAt: publishedAt ? publishedAt.toISOString() : null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        throw new ContentError(409, 'News slug already exists', 'SLUG_TAKEN');
      }
      throw err;
    }
  }

  async adminUpdateNews(
    id: string,
    input: { title?: string; summary?: string; content?: string },
    actor: Actor
  ): Promise<AdminNewsPostDto> {
    this.requireAdmin(actor);
    const existing = (await this.db.query<{ id: string }>(`SELECT id FROM news_posts WHERE id = $1`, [id])).rows[0];
    if (!existing) throw new ContentError(404, 'News post not found', 'NOT_FOUND');

    const updates: string[] = [];
    const values: unknown[] = [id];
    let idx = 2;

    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title || title.length > 150) throw new ContentError(400, 'Invalid title', 'INVALID_TITLE');
      updates.push(`title = $${idx++}`);
      values.push(title);
    }
    if (input.summary !== undefined) {
      const summary = input.summary.trim();
      if (!summary || summary.length > 500) throw new ContentError(400, 'Invalid summary', 'INVALID_SUMMARY');
      updates.push(`summary = $${idx++}`);
      values.push(summary);
    }
    if (input.content !== undefined) {
      const content = input.content.trim();
      if (!content || content.length > 50000) throw new ContentError(400, 'Invalid content', 'INVALID_CONTENT');
      updates.push(`content = $${idx++}`);
      values.push(content);
    }

    updates.push(`updated_at = clock_timestamp()`);

    const result = await this.db.query<{
      id: string;
      slug: string;
      title: string;
      summary: string;
      content: string;
      state: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
      author_user_id: string;
      published_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE news_posts SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );

    const row = result.rows[0];
    return {
      id: row.id as UUID,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      content: row.content,
      state: row.state,
      authorUserId: row.author_user_id as UUID,
      publishedAt: row.published_at ? row.published_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async adminSetNewsState(id: string, state: 'PUBLISHED' | 'ARCHIVED' | 'DRAFT', actor: Actor): Promise<AdminNewsPostDto> {
    this.requireAdmin(actor);
    const result = await this.db.query<{
      id: string;
      slug: string;
      title: string;
      summary: string;
      content: string;
      state: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
      author_user_id: string;
      published_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE news_posts
       SET state = $2,
           published_at = CASE WHEN $2 = 'PUBLISHED' AND published_at IS NULL THEN clock_timestamp() ELSE published_at END,
           updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING *`,
      [id, state]
    );

    const row = result.rows[0];
    if (!row) throw new ContentError(404, 'News post not found', 'NOT_FOUND');
    return {
      id: row.id as UUID,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      content: row.content,
      state: row.state,
      authorUserId: row.author_user_id as UUID,
      publishedAt: row.published_at ? row.published_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /* ---------------------------------------------------------------------------------------------
   * Starter Bot Templates
   * ------------------------------------------------------------------------------------------- */

  async listActiveStarterBots(): Promise<{ templates: StarterBotTemplateDto[] }> {
    const result = await this.db.query<{
      id: string;
      slug: string;
      name: string;
      language: BotLanguage;
      entrypoint: string;
      description: string | null;
      source_digest: string;
      version: number;
      is_active: boolean;
      created_at: Date;
    }>(
      `SELECT id, slug, name, language, entrypoint, description, source_digest, version, is_active, created_at
       FROM starter_bot_templates
       WHERE is_active = TRUE
       ORDER BY name ASC`
    );

    return {
      templates: result.rows.map((row) => ({
        id: row.id as UUID,
        slug: row.slug,
        name: row.name,
        language: row.language,
        entrypoint: row.entrypoint,
        description: row.description,
        sourceDigest: row.source_digest,
        version: row.version,
        isActive: row.is_active,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async getStarterBotDownload(idOrSlug: string): Promise<{ template: StarterBotTemplateDto; zipBuffer: Buffer }> {
    const result = await this.db.query<{
      id: string;
      slug: string;
      name: string;
      language: BotLanguage;
      entrypoint: string;
      description: string | null;
      source_digest: string;
      version: number;
      is_active: boolean;
      created_at: Date;
    }>(
      `SELECT * FROM starter_bot_templates WHERE (id::text = $1 OR slug = $1) AND is_active = TRUE`,
      [idOrSlug]
    );

    const row = result.rows[0];
    if (!row) throw new ContentError(404, 'Starter bot template not found', 'NOT_FOUND');

    const source = await this.artifactStore.getSource(row.source_digest);
    if (!source) throw new ContentError(500, 'Template source zip missing from object storage', 'SOURCE_MISSING');

    return {
      template: {
        id: row.id as UUID,
        slug: row.slug,
        name: row.name,
        language: row.language,
        entrypoint: row.entrypoint,
        description: row.description,
        sourceDigest: row.source_digest,
        version: row.version,
        isActive: row.is_active,
        createdAt: row.created_at.toISOString(),
      },
      zipBuffer: source.zipBuffer,
    };
  }

  async adminCreateStarterBot(
    input: {
      name: string;
      slug: string;
      language: BotLanguage;
      entrypoint: string;
      description?: string;
      zipBuffer: Buffer;
    },
    actor: Actor
  ): Promise<StarterBotTemplateDto> {
    this.requireAdmin(actor);
    const name = input.name?.trim() ?? '';
    const slug = (input.slug?.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-+|-+$/g, '');
    const entrypoint = input.entrypoint?.trim() ?? '';
    const description = input.description?.trim() || null;

    if (!name || name.length > 100) throw new ContentError(400, 'Valid name required (max 100 chars)', 'INVALID_NAME');
    if (!slug || !SLUG_PATTERN.test(slug)) throw new ContentError(400, 'Slug must be valid kebab-case', 'INVALID_SLUG');
    if (!['PYTHON', 'TYPESCRIPT', 'CPP'].includes(input.language)) {
      throw new ContentError(400, 'Language must be PYTHON, TYPESCRIPT or CPP', 'INVALID_LANGUAGE');
    }
    if (!entrypoint) throw new ContentError(400, 'Entrypoint required', 'INVALID_ENTRYPOINT');

    const stored = await this.artifactStore.storeSource(input.zipBuffer, input.language, entrypoint);
    try {
      const result = await this.db.query<{
        id: string;
        created_at: Date;
        version: number;
      }>(
        `INSERT INTO starter_bot_templates (slug, name, language, entrypoint, description, source_digest, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             language = EXCLUDED.language,
             entrypoint = EXCLUDED.entrypoint,
             description = EXCLUDED.description,
             source_digest = EXCLUDED.source_digest,
             version = starter_bot_templates.version + 1,
             is_active = TRUE,
             updated_at = clock_timestamp()
         RETURNING id, created_at, version`,
        [slug, name, input.language, entrypoint, description, stored.digest, actor.userId]
      );
      const row = result.rows[0];
      return {
        id: row.id as UUID,
        slug,
        name,
        language: input.language,
        entrypoint,
        description,
        sourceDigest: stored.digest,
        version: row.version ?? 1,
        isActive: true,
        createdAt: row.created_at.toISOString(),
      };
    } catch (err: unknown) {
      throw err;
    }
  }

  async adminArchiveStarterBot(id: string, actor: Actor): Promise<void> {
    this.requireAdmin(actor);
    const result = await this.db.query(
      `UPDATE starter_bot_templates SET is_active = FALSE, updated_at = clock_timestamp() WHERE id = $1`,
      [id]
    );
    if (!result.rowCount) throw new ContentError(404, 'Starter bot template not found', 'NOT_FOUND');
  }

  /**
   * Seeds the standard Python, TypeScript, and C++ starter bots from `sdk/` if missing.
   */
  async seedBuiltinStarterBots(adminUserId?: string): Promise<void> {
    const admin = (await this.db.query<{ id: string }>(`SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at ASC LIMIT 1`)).rows[0];
    const authorId = admin?.id ?? adminUserId;
    if (!authorId) return;
    const starters = [
      {
        slug: 'official-python-starter',
        name: 'Python 3 Heuristic Starter',
        language: 'PYTHON' as const,
        entrypoint: 'starter_bot.py',
        description: 'Bot mẫu Python 3 sử dụng OanTuTi SDK (chiến thuật Throne Breach và Dominant Capture).',
        files: [
          { name: 'starter_bot.py', relativePath: 'sdk/python/starter_bot.py' },
          { name: 'oantuti.py', relativePath: 'sdk/python/oantuti.py' },
        ],
      },
      {
        slug: 'official-typescript-starter',
        name: 'TypeScript Starter',
        language: 'TYPESCRIPT' as const,
        entrypoint: 'starter_bot.ts',
        description: 'Bot mẫu TypeScript sử dụng OanTuTi SDK.',
        files: [
          { name: 'starter_bot.ts', relativePath: 'sdk/typescript/starter_bot.ts' },
          { name: 'oantuti.ts', relativePath: 'sdk/typescript/oantuti.ts' },
        ],
      },
      {
        slug: 'official-cpp-starter',
        name: 'C++20 Heuristic Starter',
        language: 'CPP' as const,
        entrypoint: 'starter_bot.cpp',
        description: 'Bot mẫu C++20 header-only sử dụng oantuti.hpp.',
        files: [
          { name: 'starter_bot.cpp', relativePath: 'sdk/cpp/starter_bot.cpp' },
          { name: 'oantuti.hpp', relativePath: 'sdk/cpp/oantuti.hpp' },
        ],
      },
    ];

    const projectRoot = process.cwd();

    for (const item of starters) {
      const existing = (await this.db.query<{ id: string }>(`SELECT id FROM starter_bot_templates WHERE slug = $1`, [item.slug])).rows[0];
      if (existing) continue;

      const fileEntries: { name: string; bytes: Buffer }[] = [];
      let allFound = true;
      for (const f of item.files) {
        const fullPath = path.resolve(projectRoot, f.relativePath);
        if (!existsSync(fullPath)) {
          allFound = false;
          break;
        }
        fileEntries.push({ name: f.name, bytes: readFileSync(fullPath) });
      }

      if (!allFound) continue;

      const zip = writeStoredZip(fileEntries);
      const stored = await this.artifactStore.storeSource(zip, item.language, item.entrypoint);

      await this.db.query(
        `INSERT INTO starter_bot_templates (slug, name, language, entrypoint, description, source_digest, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (slug) DO NOTHING`,
        [item.slug, item.name, item.language, item.entrypoint, item.description, stored.digest, authorId]
      );
    }
  }
}
