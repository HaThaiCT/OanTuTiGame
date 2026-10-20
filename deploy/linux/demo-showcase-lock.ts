import { open, unlink } from 'node:fs/promises';

export async function withShowcaseLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  let lock;
  try {
    lock = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`showcase seeder is already running or has a stale lock: ${path}`);
    throw error;
  }
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    await lock.sync();
    return await work();
  } finally {
    await lock.close();
    await unlink(path);
  }
}
