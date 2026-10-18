import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('../deploy/linux/workspace.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ $data: true }).compile(schema);
const fixture = {
  schemaVersion: 1, purpose: 'PERSONAL_DEVELOPMENT_FIXTURE',
  deploymentId: '3c4e2380-eaf2-4d1b-950e-dcb98dc2b561',
  organizationId: '0635c740-b5e3-4131-88ab-d28dd2d9a2b5',
  organizationLabel: 'Test workspace', operatorOsUser: 'developer',
  profile: 'LAN_OFFLINE', publicBaseUrl: 'https://localhost:8443',
  allowedOrigins: ['https://localhost:8443'], bindAddress: '127.0.0.1',
  pgDatabase: 'arena_development', pgSocketPath: '/private/socket', pgPort: 55432,
  pgAppRole: 'arena_app', pgMigratorRole: 'arena_migrator', pgBackupRole: 'arena_backup',
  tlsCertPath: '/private/server.crt', tlsKeyPath: '/private/server.key', lanCaBundlePath: '/private/ca.crt',
  releaseContacts: null, backupTarget: null, developmentConfigReady: false, releaseReady: false,
  pending: ['canonical-config-schema-validation'], notes: [],
};

describe('Personal development workspace boundary', () => {
  it('accepts private inventory without converting pending evidence into readiness', () => {
    expect(validate(structuredClone(fixture))).toBe(true);
  });
  it.each([
    ['public listener', { bindAddress: '0.0.0.0' }],
    ['release bypass', { releaseReady: true }],
    ['development readiness bypass', { developmentConfigReady: true }],
    ['foreign origin', { allowedOrigins: ['https://attacker.example'] }],
    ['plaintext URL', { publicBaseUrl: 'http://localhost:8443' }],
    ['invalid UUID', { deploymentId: 'not-a-uuid' }],
    ['shared DDL role', { pgAppRole: 'arena_migrator' }],
    ['invalid port', { pgPort: 65536 }],
    ['relative key path', { tlsKeyPath: 'server.key' }],
    ['unexpected secret field', { password: 'never-log-this' }],
    ['unselected profile', { profile: 'ONLINE' }],
  ])('rejects %s', (_, mutation) => {
    expect(validate({ ...structuredClone(fixture), ...mutation })).toBe(false);
  });
});
