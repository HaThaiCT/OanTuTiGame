import { isAbsolute, normalize, relative, resolve, parse, join, sep } from 'node:path';
import { lstatSync } from 'node:fs';

export interface ConfigError { readonly field: string; readonly code: string }
export interface RebuildConfig {
  readonly schemaVersion: 1;
  readonly purpose: 'ISOLATED_REBUILD_DEVELOPMENT';
  readonly deploymentId: string;
  readonly profile: 'LAN_OFFLINE' | 'ONLINE';
  readonly bindAddress: '127.0.0.1';
  readonly webPort: number;
  readonly apiPort: number;
  readonly runtimeRoot: string;
  readonly pgDatabase: string;
  readonly pgSocketPath: string;
  readonly pgPort: number;
  readonly pgAppRole: string;
  readonly pgMigratorRole: string;
  readonly pgBackupRole: string;
  readonly objectRoot: string;
  readonly stagingRoot: string;
  readonly spoolRoot: string;
}
export type ValidationResult = {
  readonly ok: true; readonly config: RebuildConfig; readonly errors: readonly [];
  readonly releaseReady: false; readonly runtimeCertification: 'PENDING_RUNTIME_PROOF';
} | {
  readonly ok: false; readonly errors: readonly ConfigError[];
  readonly releaseReady: false; readonly runtimeCertification: 'PENDING_RUNTIME_PROOF';
};
const fields = ['schemaVersion', 'purpose', 'deploymentId', 'profile', 'bindAddress', 'webPort', 'apiPort',
  'runtimeRoot', 'pgDatabase', 'pgSocketPath', 'pgPort', 'pgAppRole', 'pgMigratorRole', 'pgBackupRole',
  'objectRoot', 'stagingRoot', 'spoolRoot'] as const;
const stringFields = ['deploymentId', 'profile', 'bindAddress', 'runtimeRoot', 'pgDatabase', 'pgSocketPath',
  'pgAppRole', 'pgMigratorRole', 'pgBackupRole', 'objectRoot', 'stagingRoot', 'spoolRoot'] as const;
const pathFields = ['runtimeRoot', 'pgSocketPath', 'objectRoot', 'stagingRoot', 'spoolRoot'] as const;
const roleFields = ['pgAppRole', 'pgMigratorRole', 'pgBackupRole'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sqlName = /^arena_rebuild_[a-z0-9_]+$/;
function inside(root: string, value: string): boolean {
  const suffix = relative(resolve(root), resolve(value));
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

function safeExistingParents(path: string): boolean {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true;
      return false;
    }
  }
  return true;
}

/** Development isolation only; never certifies installed runtime or production readiness. */
export function validateRebuildConfig(input: unknown, forbiddenRoots: readonly string[]): ValidationResult {
  const errors: ConfigError[] = [];
  const fail = (field: string, code: string) => errors.push({ field, code });
  const readiness = { releaseReady: false, runtimeCertification: 'PENDING_RUNTIME_PROOF' } as const;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '$', code: 'OBJECT_REQUIRED' }], ...readiness };
  }
  // Object.entries exposes unknown values; each field is validated before constructing typed config.
  const value: Record<string, unknown> = Object.fromEntries(Object.entries(input));
  for (const key of Object.keys(value)) if (!fields.some(field => field === key)) fail(key, 'UNKNOWN_FIELD');
  for (const key of fields) if (!(key in value)) fail(key, 'REQUIRED');
  for (const key of stringFields) if (typeof value[key] !== 'string' || value[key] === '') fail(key, 'STRING_REQUIRED');
  if (value.schemaVersion !== 1) fail('schemaVersion', 'UNSUPPORTED_VERSION');
  if (value.purpose !== 'ISOLATED_REBUILD_DEVELOPMENT') fail('purpose', 'DEVELOPMENT_ONLY');
  if (typeof value.deploymentId !== 'string' || !uuid.test(value.deploymentId)) fail('deploymentId', 'UUID_REQUIRED');
  if (value.profile !== 'LAN_OFFLINE' && value.profile !== 'ONLINE') fail('profile', 'INVALID_PROFILE');
  if (value.bindAddress !== '127.0.0.1') fail('bindAddress', 'LOOPBACK_REQUIRED');
  for (const key of ['webPort', 'apiPort', 'pgPort'] as const) {
    const port = value[key];
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) fail(key, 'INVALID_PORT');
  }
  if (value.webPort === value.apiPort) fail('apiPort', 'DISTINCT_PORT_REQUIRED');
  for (const key of ['pgDatabase', ...roleFields] as const) {
    const name = value[key];
    if (typeof name !== 'string' || !sqlName.test(name) || name.length > 63) fail(key, 'ISOLATED_SQL_NAME_REQUIRED');
  }
  for (const key of roleFields) {
    if (roleFields.some(other => other !== key && value[other] === value[key])) fail(key, 'DISTINCT_ROLE_REQUIRED');
  }
  for (const key of pathFields) {
    const path = value[key];
    if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
      fail(key, 'CANONICAL_ABSOLUTE_PATH_REQUIRED'); continue;
    }
    if (forbiddenRoots.some(root => inside(root, path) || inside(path, root))) fail(key, 'DONOR_PATH_FORBIDDEN');
    if (!safeExistingParents(path)) fail(key, 'UNSAFE_FILESYSTEM_PATH');
    try {
      const stat = lstatSync(path);
      if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
        fail(key, 'PRIVATE_OWNED_DIRECTORY_REQUIRED');
      }
    } catch (error: unknown) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        fail(key, 'FILESYSTEM_ACCESS_DENIED');
      }
    }
    if (key !== 'runtimeRoot' && typeof value.runtimeRoot === 'string' &&
      (path === value.runtimeRoot || !inside(value.runtimeRoot, path))) fail(key, 'OUTSIDE_RUNTIME_ROOT');
  }
  const roots = ['pgSocketPath', 'objectRoot', 'stagingRoot', 'spoolRoot'] as const;
  for (const key of roots) {
    const path = value[key];
    if (typeof path !== 'string') continue;
    if (roots.some(other => {
      const otherPath = value[other];
      return other !== key && typeof otherPath === 'string' &&
        (inside(path, otherPath) || inside(otherPath, path));
    })) fail(key, 'OVERLAPPING_STORAGE_DOMAIN');
  }
  if (errors.length) return { ok: false, errors, ...readiness };
  // All fields above have explicit runtime guards; this assertion does not parse external data unchecked.
  const config = value as unknown as RebuildConfig;
  return { ok: true, config, errors: [], ...readiness };
}
