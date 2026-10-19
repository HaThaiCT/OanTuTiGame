import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Completion capsules are the durable recovery artifact of a *pinned* completion: the independent
 * consumer reads one to accept a job whose worker is gone. Once the completion is accepted (or
 * rejected) nothing reads the capsule again, and the backup contract requires the root to be
 * inventoried on every checkpoint — so an unbounded root inflates every backup forever.
 *
 * A capsule is deleted only when it is older than the grace window and no `PENDING` completion
 * names it. Objects it referenced are deleted only when no remaining capsule references them,
 * because grants are content-addressed and two pending completions can share an object.
 */
export function sweepCompletionCapsules(
  directory: string,
  pendingCapsuleDigests: ReadonlySet<string>,
  options: { readonly now?: number; readonly graceMs?: number } = {}
): { readonly capsules: number; readonly objects: number } {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? 7 * 24 * 60 * 60 * 1_000;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { capsules: 0, objects: 0 };
    throw error;
  }

  const capsuleFiles = names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  const stale = capsuleFiles.filter((name) => {
    const digest = name.slice(0, 64);
    return !pendingCapsuleDigests.has(digest) && now - statSync(join(directory, name)).mtimeMs >= graceMs;
  });
  const removed = new Set(stale);
  for (const name of stale) unlinkSync(join(directory, name));

  // Every object still referenced by a surviving capsule must stay: digests are content-addressed.
  const referenced = new Set<string>();
  for (const name of capsuleFiles) {
    if (removed.has(name)) continue;
    try {
      const capsule = JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
        objects?: readonly { digest?: unknown }[];
        artifactRef?: { digest?: unknown };
      };
      for (const ref of [...(capsule.objects ?? []), ...(capsule.artifactRef ? [capsule.artifactRef] : [])]) {
        if (typeof ref.digest === 'string') referenced.add(ref.digest);
      }
    } catch {
      // A capsule that cannot be parsed is itself suspect; leave its objects for the operator
      // rather than deleting evidence an incident review might need.
      for (const other of names) {
        const match = /^([a-f0-9]{64})\.object$/.exec(other);
        if (match) referenced.add(match[1]);
      }
    }
  }

  let objects = 0;
  for (const name of names) {
    const match = /^([a-f0-9]{64})\.object$/.exec(name);
    if (!match || referenced.has(match[1])) continue;
    if (now - statSync(join(directory, name)).mtimeMs < graceMs) continue;
    unlinkSync(join(directory, name));
    objects++;
  }
  return { capsules: stale.length, objects };
}
