/**
 * Highest migration this build ships.
 *
 * Operators need one number to compare a running database against (`GET /api/health/ready`
 * reports it), and reading the migrations directory at runtime is not dependable in a packaged
 * image. `tests/schema-version.test.ts` fails when this constant drifts from the newest
 * `persistence/migrations/*.sql` file, so the pair cannot silently disagree.
 */
export const EXPECTED_SCHEMA_VERSION = 33;
