import { access, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run before `next dev` and `next build`; this uses the installed, lockfile-pinned
// package only. It never downloads assets. Next serves public/monaco at /monaco.
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const monacoRoot = resolve(dirname(fileURLToPath(import.meta.resolve('monaco-editor'))), '../..');
const source = resolve(monacoRoot, 'min/vs');
const destination = resolve(webRoot, 'public/monaco');
const { version } = JSON.parse(await readFile(resolve(monacoRoot, 'package.json'), 'utf8'));

// Fail the build rather than publish a page whose editor needs a CDN or a
// plaintext fallback. Copy the whole distribution: language modules, workers,
// CSS, fonts and NLS files all use paths relative to this tree.
await Promise.all([
  'loader.js',
  'editor/editor.main.js',
  'editor/editor.main.css',
  'assets',
].map((path) => access(resolve(source, path))));
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, resolve(destination, 'vs'), { recursive: true });
await cp(resolve(monacoRoot, 'LICENSE'), resolve(destination, 'LICENSE'));
await cp(resolve(monacoRoot, 'ThirdPartyNotices.txt'), resolve(destination, 'ThirdPartyNotices.txt'));
console.log(`Copied Monaco ${version} JS, workers, CSS and local assets to ${destination}`);

// brackets-viewer 1.9.1 publishes a browser bundle, not its advertised JS entry.
// Bundle locally with its own LICENSE file: npm metadata says ISC while the shipped file is MIT —
// the copy keeps whatever the package actually ships. LAN pages must never fetch a CDN.
const bracketRoot = dirname(fileURLToPath(import.meta.resolve('brackets-viewer/package.json')));
const bracketDestination = resolve(webRoot, 'public/brackets');
await mkdir(bracketDestination, { recursive: true });
await Promise.all(['brackets-viewer.min.js', 'brackets-viewer.min.css'].map((name) =>
  cp(resolve(bracketRoot, 'dist', name), resolve(bracketDestination, name))));
await cp(resolve(bracketRoot, 'LICENSE'), resolve(bracketDestination, 'LICENSE'));
