import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Database, type BotRow } from './db.js';
import { AuthService, HttpError, botSourceFields, objectPayload } from './auth.js';

function detail(bot: BotRow) {
  return { id: bot.id, name: bot.name, language: bot.language, sourceCode: bot.source_code, version: bot.version, userId: bot.user_id, isActive: Boolean(bot.is_active) };
}
function immutableSourceFile(botsDir: string, language: BotRow['language'], sourceCode: string): string {
  mkdirSync(botsDir, { recursive: true });
  const extensions = { PYTHON: 'py', TYPESCRIPT: 'ts', JAVASCRIPT: 'js', CPP: 'cpp', JAVA: 'java', GO: 'go' };
  const filePath = join(botsDir, `${randomUUID()}.${extensions[language]}`);
  // Unique read-only version paths keep in-flight and historical matches stable.
  writeFileSync(filePath, sourceCode, { flag: 'wx', mode: 0o444 });
  return filePath;
}

export function migrateBotSourceFiles(db: Database, botsDir: string): void {
  for (const bot of db.listBotsWithoutSourcePath()) {
    let filePath: string | undefined;
    try {
      db.transaction(() => {
        filePath = immutableSourceFile(botsDir, bot.language, bot.source_code);
        db.assignMigratedSourcePath(bot.id, bot.version, filePath);
      });
    } catch (error) { if (filePath) unlinkSync(filePath); throw error; }
  }
}

export function registerBotRoutes(app: FastifyInstance, db: Database, auth: AuthService, botsDir: string): void {
  function owned(id: string, userId: string): BotRow {
    const bot = db.getBotById(id);
    if (!bot || bot.user_id !== userId || bot.user_id === 'usr_system') throw new HttpError(404, 'Bot not found');
    return bot;
  }
  app.get<{ Querystring: { mine?: string } }>('/api/bots', async (request) => {
    if (request.query.mine !== undefined && request.query.mine !== '1') throw new HttpError(400, 'Invalid mine filter');
    const ownerId = request.query.mine === '1' ? auth.requireUser(request).id : undefined;
    return { bots: db.listBots().filter((bot) => !ownerId || bot.user_id === ownerId).map(({ id, name, language, elo, version, user_id }) => ({ id, name, language, elo, version, user_id })) };
  });
  app.post('/api/bots', async (request, reply) => {
    const user = auth.requireUser(request);
    const fields = botSourceFields(objectPayload(request.body, ['name', 'language', 'sourceCode']));
    let filePath: string | undefined;
    try {
      const bot = db.transaction(() => {
        if (db.getOwnedBotByName(user.id, fields.name)) throw new HttpError(409, 'Bot name already exists');
        filePath = immutableSourceFile(botsDir, fields.language, fields.sourceCode);
        return db.createBot({ ...fields, userId: user.id, filePath });
      });
      return reply.code(201).send({ bot: detail(bot) });
    } catch (error) { if (filePath) unlinkSync(filePath); throw error; }
  });
  app.get<{ Params: { id: string } }>('/api/bots/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { bot: detail(owned(request.params.id, auth.requireUser(request).id)) };
  });
  app.put<{ Params: { id: string } }>('/api/bots/:id', async (request) => {
    const user = auth.requireUser(request);
    const payload = objectPayload(request.body, ['name', 'language', 'sourceCode', 'version']);
    const fields = botSourceFields(payload);
    if (typeof payload.version !== 'number' || !Number.isInteger(payload.version) || payload.version < 1) throw new HttpError(400, 'Invalid version');
    const version = payload.version;
    let filePath: string | undefined;
    try {
      const bot = db.transaction(() => {
        const current = owned(request.params.id, user.id);
        if (!current.is_active) throw new HttpError(409, 'Bot is deleted');
        if (current.version !== version) throw new HttpError(409, 'Bot has changed; reload before saving');
        const duplicate = db.getOwnedBotByName(user.id, fields.name);
        if (duplicate && duplicate.id !== current.id) throw new HttpError(409, 'Bot name already exists');
        filePath = immutableSourceFile(botsDir, fields.language, fields.sourceCode);
        const updated = db.updateOwnedBot(current.id, user.id, version, { ...fields, filePath });
        if (!updated) throw new HttpError(409, 'Bot has changed; reload before saving');
        return updated;
      });
      return { bot: detail(bot) };
    } catch (error) { if (filePath) unlinkSync(filePath); throw error; }
  });
  app.delete<{ Params: { id: string } }>('/api/bots/:id', async (request, reply) => {
    const user = auth.requireUser(request); owned(request.params.id, user.id);
    db.deactivateBot(request.params.id, user.id);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>('/api/bots/:id/versions', async (request, reply) => {
    owned(request.params.id, auth.requireUser(request).id);
    reply.header('Cache-Control', 'no-store');
    return { versions: db.listBotVersions(request.params.id) };
  });
}
