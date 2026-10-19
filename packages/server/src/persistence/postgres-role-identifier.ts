const ROLE_NAME = /^[a-z_][a-z0-9_$]{0,62}$/;

/** PostgreSQL parameters cannot bind identifiers; only quote an already constrained role name. */
export function quotePostgresRole(role: string): string {
  if (!ROLE_NAME.test(role)) throw new Error('Invalid PostgreSQL role identifier');
  return `"${role}"`;
}
