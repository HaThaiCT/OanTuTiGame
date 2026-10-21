import { constants, closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export function stageOperatorSecrets(env: NodeJS.ProcessEnv = process.env): () => void {
  const stagedDirectory = mkdtempSync(join(tmpdir(), 'oantuti-ops-'));
  try {
    const stageSecret = (name: string): void => {
      const source = env[name];
      if (!source) return;
      let fd: number | undefined;
      try {
        fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        const uid = process.getuid?.();
        if (!stat.isFile() || (uid !== undefined && uid !== 0 && stat.uid !== uid && stat.uid !== 0) || stat.size < 1 || stat.size > 65536) throw new Error();
        const contents = readFileSync(fd);
        if (contents.length !== stat.size) throw new Error();
        const target = join(stagedDirectory, basename(name));
        writeFileSync(target, contents, { flag: 'wx', mode: 0o600 });
        env[name] = target;
      } catch {
        throw new Error(`Invalid ${name}`);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    };
    stageSecret('PGPASSWORD_FILE');
    stageSecret('OANTUTI_SMTP_PASSWORD_FILE');
    stageSecret('OANTUTI_MAIL_KEYRING_FILE');
    return () => rmSync(stagedDirectory, { recursive: true, force: true });
  } catch (error) {
    rmSync(stagedDirectory, { recursive: true, force: true });
    throw error;
  }
}
