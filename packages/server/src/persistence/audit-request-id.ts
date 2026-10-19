/**
 * `audit_events.request_id` is UUID-typed while a Fastify request id is free-form (and may be
 * absent when a service is called directly, e.g. from a CLI or a test). Audit rows must still be
 * written in those cases, so a non-UUID id is recorded as NULL rather than dropping the whole row.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function auditRequestId(requestId: string | undefined): string | null {
  return requestId !== undefined && UUID_PATTERN.test(requestId) ? requestId : null;
}
