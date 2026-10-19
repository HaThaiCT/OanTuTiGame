import { chmodSync, lstatSync, mkdirSync } from 'node:fs';

/**
 * A directory that holds immutable evidence bytes (submitted sources, replay objects, compiled
 * artifacts) must be a real directory owned by this process and closed to everyone else. The
 * deployment backs these trees up and restores them by digest, and the checkpoint producer refuses
 * a tree that is not private — so a permissive root would silently make recovery impossible. The
 * check runs at construction, where the answer is still actionable, instead of at backup time.
 *
 * `ownedByConvention` is for the store's own default path under the application data directory:
 * the application created that path, so an existing but permissive directory is tightened rather
 * than fatal. A root the operator passed explicitly is never chmodded — refusing to run is the
 * only safe answer for a path the operator chose, since rewriting its permissions could hide a
 * misconfiguration (or someone else's directory entirely).
 */
export function assertPrivateObjectRoot(
  root: string,
  label: string,
  options: { readonly ownedByConvention?: boolean } = {}
): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink or file: ${root}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} must be owned by the service identity: ${root} is owned by uid ${stat.uid}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    if (options.ownedByConvention !== true) {
      throw new Error(`${label} must not be group/world accessible: ${root} is ${(stat.mode & 0o777).toString(8)}; run chmod 700 on it and its parent tree`);
    }
    chmodSync(root, 0o700);
    stat = lstatSync(root);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${label} could not be made private: ${root}`);
  }
}
