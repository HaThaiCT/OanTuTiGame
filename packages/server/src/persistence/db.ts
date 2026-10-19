import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';

const { Pool } = pg;

export interface DbConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly max?: number;
}

/**
 * A statement runner usable both by a module on its own connection and inside a caller's
 * transaction. PostgreSQL's own client type declares mutable parameter arrays, so the union of the
 * two identities is not callable directly even though both accept the same statements at runtime.
 */
export type StatementRunner = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: readonly unknown[]
) => Promise<pg.QueryResult<T>>;

export function statementRunner(executor: PostgresDatabase | pg.PoolClient): StatementRunner {
  return (executor.query as unknown as StatementRunner).bind(executor) as StatementRunner;
}

const DEFAULT_WORKSPACE_PATH = '/home/ha-thai/.local/share/oantuti/development/workspace.json';

export function resolveDbConfig(override?: Partial<DbConfig>): DbConfig {
  let fileConfig: Partial<DbConfig> = {};
  if (existsSync(DEFAULT_WORKSPACE_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(DEFAULT_WORKSPACE_PATH, 'utf8'));
      fileConfig = {
        host: parsed.pgSocketPath,
        port: parsed.pgPort,
        database: parsed.pgDatabase,
        user: parsed.pgAppRole,
      };
    } catch {
      // Fallback to env or defaults
    }
  }

  return {
    host: override?.host ?? process.env.PGHOST ?? fileConfig.host ?? '/home/ha-thai/.local/share/oantuti/development/pg16/socket',
    port: override?.port ?? (process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : fileConfig.port ?? 55432),
    database: override?.database ?? process.env.PGDATABASE ?? fileConfig.database ?? 'arena_development',
    user: override?.user ?? process.env.PGUSER ?? fileConfig.user ?? 'arena_app',
    max: override?.max ?? 10,
  };
}

export class PostgresDatabase {
  private readonly pool: pg.Pool;
  private readonly config: DbConfig;

  constructor(config: DbConfig = resolveDbConfig()) {
    this.config = config;
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      max: config.max ?? 10,
    });
  }

  async connectDedicated(): Promise<pg.Client> {
    const client = new pg.Client({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
    });
    await client.connect();
    return client;
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: readonly unknown[]): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(text, params ? [...params] : undefined);
  }

  async withTransaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { PostgresDatabase as Database };
