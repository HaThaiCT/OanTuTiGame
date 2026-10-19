import { describe, it, expect } from 'vitest';
import { quotePostgresRole } from '../src/persistence/postgres-role-identifier.js';

describe('PostgreSQL role identifier', () => {
  it('quotes a simple deployment role without accepting SQL syntax', () => {
    expect(quotePostgresRole('arena_migrator')).toBe('"arena_migrator"');
    expect(() => quotePostgresRole('arena_migrator"; DROP ROLE arena_app;--')).toThrow('Invalid PostgreSQL role');
  });
});
