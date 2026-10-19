import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Legacy compatibility routes stay available in the suites that exercise them; a deployment
    // has to opt in explicitly (see auth.ts self-registration).
    env: { OANTUTI_BACKUP_FENCE: 'off', OANTUTI_LEGACY_API: '1' },
    fileParallelism: false,
    // Retires the previous file's ADMIN fixture so the per-database singleton constraint
    // (`users_singleton_admin`) can be satisfied by every suite in turn. Never runs outside
    // an `arena_*test*` database.
    setupFiles: ['packages/server/tests/setup/singleton-admin.ts'],
    testTimeout: 60000,
  },
});
