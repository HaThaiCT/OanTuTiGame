import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
export interface RatingCalculationInput {
  readonly teamId: string;
  readonly rating: number;
  readonly rank: number;
  readonly rankEnd: number;
}

export interface RatingCalculation {
  readonly teamId: string;
  readonly oldRating: number;
  readonly delta: number;
  readonly newRating: number;
}

const MIN_RATING = 0;
const MAX_RATING = 8000;

function probability(a: number, b: number): number {
  return 1 / (1 + 10 ** ((a - b) / 400));
}

function seedAt(rating: number, entries: readonly RatingCalculationInput[], selfId: string): number {
  return 1 + entries.reduce((sum, opponent) => sum + (opponent.teamId === selfId ? 0 : probability(rating, opponent.rating)), 0);
}
function validate(entries: readonly RatingCalculationInput[]): readonly RatingCalculationInput[] {
  if (entries.length < 2 || entries.length > 500) throw new Error('INVALID_CONTEST_PLACEMENT');
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}$/i.test(entry.teamId) || !Number.isInteger(entry.rating) || entry.rating < MIN_RATING || entry.rating > MAX_RATING
      || !Number.isInteger(entry.rank) || !Number.isInteger(entry.rankEnd) || entry.rank < 1 || entry.rankEnd < entry.rank || entry.rankEnd > entries.length) {
      throw new Error('INVALID_CONTEST_PLACEMENT');
    }
  }
  const ordered = [...entries].sort((a, b) => a.rank - b.rank || a.rankEnd - b.rankEnd || a.teamId.localeCompare(b.teamId));
  if (new Set(ordered.map((entry) => entry.teamId)).size !== ordered.length) throw new Error('INVALID_CONTEST_PLACEMENT');
  let expectedRank = 1;
  for (let index = 0; index < ordered.length;) {
    const entry = ordered[index];
    if (entry.rank !== expectedRank) {
      throw new Error('INVALID_CONTEST_PLACEMENT');
    }
    const groupSize = entry.rankEnd - entry.rank + 1;
    for (let member = 0; member < groupSize; member += 1) {
      const candidate = ordered[index + member];
      if (!candidate || candidate.rank !== entry.rank || candidate.rankEnd !== entry.rankEnd) throw new Error('INVALID_CONTEST_PLACEMENT');
    }
    expectedRank += groupSize;
    index += groupSize;
  }
  if (expectedRank !== ordered.length + 1) throw new Error('INVALID_CONTEST_PLACEMENT');
  return [...ordered].sort((a, b) => a.teamId.localeCompare(b.teamId));
}

function performanceRating(target: number, entry: RatingCalculationInput, entries: readonly RatingCalculationInput[]): number {
  let low = 1;
  let high = MAX_RATING;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (seedAt(middle, entries, entry.teamId) < target) high = middle;
    else low = middle;
  }
  return low;
}

export function calculateContestRating(entries: readonly RatingCalculationInput[]): readonly RatingCalculation[] {
  const ordered = validate(entries);
  const raw = ordered.map((entry) => {
    const seed = seedAt(entry.rating, ordered, entry.teamId);
    const target = Math.sqrt(seed * ((entry.rank + entry.rankEnd) / 2));
    const performance = performanceRating(target, entry, ordered);
    return { entry, delta: Math.trunc((performance - entry.rating) / 2) };
  });
  const firstCorrection = -Math.trunc(raw.reduce((sum, value) => sum + value.delta, 0) / ordered.length) - 1;
  for (const item of raw) item.delta += firstCorrection;
  const count = Math.min(ordered.length, Math.floor(4 * Math.sqrt(ordered.length)));
  const top = [...raw].sort((a, b) => b.entry.rating - a.entry.rating || a.entry.teamId.localeCompare(b.entry.teamId)).slice(0, count);
  const secondCorrection = Math.min(0, Math.max(-10, -Math.trunc(top.reduce((sum, value) => sum + value.delta, 0) / count)));
  return raw.map(({ entry, delta }) => {
    const newRating = Math.min(MAX_RATING, Math.max(MIN_RATING, entry.rating + delta + secondCorrection));
    return { teamId: entry.teamId, oldRating: entry.rating, delta: newRating - entry.rating, newRating };
  });
}

export async function calculateContestRatingAsync(entries: readonly RatingCalculationInput[]): Promise<readonly RatingCalculation[]> {
  if (!isMainThread) return calculateContestRating(entries);
  const { promise, resolve, reject } = Promise.withResolvers<readonly RatingCalculation[]>();
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: entries, execArgv: process.execArgv });
  worker.once('message', (message: readonly RatingCalculation[] | { error: string }) => {
    if ('error' in message) reject(new Error(message.error));
    else resolve(message);
  });
  worker.once('error', reject);
  worker.once('exit', (code) => {
    if (code !== 0) reject(new Error(`RATING_WORKER_EXIT_${code}`));
  });
  return promise;
}

if (!isMainThread && parentPort) {
  try {
    parentPort.postMessage(calculateContestRating(workerData as readonly RatingCalculationInput[]));
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
}
