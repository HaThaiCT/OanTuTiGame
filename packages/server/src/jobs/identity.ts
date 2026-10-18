/**
 * Per-process job worker / reconciler identities.
 *
 * Lease fencing keys attempts on `worker_id` + pid, so one process is one worker: the uuid
 * below is generated once per process and reused by every claim it makes. The autonomous
 * worker (`TournamentAutoRunner`) and the organizer HTTP route that drives the same
 * claim/complete path share this identity, which is what makes an API restart take over the
 * leases its previous incarnation left behind instead of fighting them.
 */

import { randomUUID } from 'node:crypto';
import type { ReconcilerIdentity, WorkerIdentity } from '@oantuti/protocol';

const PROCESS_UUID = randomUUID();
const PROCESS_UID = typeof process.getuid === 'function' ? process.getuid() : 0;

/** Identity this process claims jobs with (stable for the lifetime of the process). */
export const PROCESS_WORKER_IDENTITY: WorkerIdentity = {
  workerId: `dev-worker-${PROCESS_UUID}`,
  pid: process.pid,
  uid: PROCESS_UID,
};

/** Identity this process reconciles expired leases with. */
export const PROCESS_RECONCILER_IDENTITY: ReconcilerIdentity = {
  reconcilerId: `dev-reconciler-${PROCESS_UUID}`,
  pid: process.pid,
  uid: PROCESS_UID,
};
