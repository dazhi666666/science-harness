#!/usr/bin/env node
// One-shot dsh-web/ builder: overlays the two integration files onto apps/web/,
// builds, captures the rendered frontend via capture-dsh-web.mjs, copies the
// dist assets, and restores apps/web/ exactly as it was.
//
// The overlay files live in ../web/dsh-harness-patch/ (router-transport.ts and
// a main.ts that wraps start() behind a router-transport import); the capture
// script boots `node apps/cli/lib/bin.js --profile web` with a scratch
// DSH_HOME and saves the rendered page plus every plugin bundle.
//
// Usage (from integrations/agent-router/harness/):
//   node build-dsh-web.mjs              full: pnpm run build, then capture
//   node build-dsh-web.mjs --no-build   capture only (build outputs present)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ROUTER_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(ROUTER_ROOT, '..', '..');
const PATCH_DIR = path.join(ROUTER_ROOT, 'web', 'dsh-harness-patch');
const APP_WEB_SRC = path.join(REPO_ROOT, 'apps', 'web', 'src');
const DSH_WEB = path.join(ROUTER_ROOT, 'dsh-web');

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
};

function mustExist(file, hint) {
  if (!fs.existsSync(file)) {
    console.error(`build-dsh-web: missing ${file}\n${hint}`);
    process.exit(1);
  }
}

mustExist(path.join(REPO_ROOT, 'apps', 'web', 'src', 'main.ts'), 'this script must run inside the science-harness checkout');
mustExist(path.join(PATCH_DIR, 'router-transport.ts'), 'the patch directory is incomplete');
if (!process.argv.includes('--no-build')) {
  mustExist(path.join(REPO_ROOT, 'node_modules'), 'run `pnpm install` first');
  mustExist(path.join(REPO_ROOT, 'apps', 'cli', 'lib', 'bin.js'), 'run `pnpm run build` first (the capture boots apps/cli/lib/bin.js)');
}

const overlay = [
  ['router-transport.ts', path.join(APP_WEB_SRC, 'router-transport.ts')],
  ['main.ts', path.join(APP_WEB_SRC, 'main.ts')],
];
const backup = new Map();
for (const [, dest] of overlay) backup.set(dest, fs.existsSync(dest) ? fs.readFileSync(dest) : null);

try {
  for (const [name, dest] of overlay) fs.copyFileSync(path.join(PATCH_DIR, name), dest);
  if (!process.argv.includes('--no-build')) sh('pnpm', ['run', 'build']);
  fs.rmSync(DSH_WEB, { recursive: true, force: true });
  sh('node', [path.join(PATCH_DIR, 'capture-dsh-web.mjs'), REPO_ROOT, DSH_WEB, '3080']);
  const dist = path.join(REPO_ROOT, 'apps', 'web', 'dist');
  mustExist(path.join(dist, 'index.html'), 'the frontend build did not produce apps/web/dist');
  fs.rmSync(path.join(DSH_WEB, 'dist'), { recursive: true, force: true });
  fs.cpSync(dist, path.join(DSH_WEB, 'dist'), { recursive: true });
  console.log(`build-dsh-web: captured to ${DSH_WEB}`);
} finally {
  for (const [dest, buf] of backup) {
    if (buf === null) fs.rmSync(dest, { force: true });
    else fs.writeFileSync(dest, buf);
  }
  const dirty = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', 'apps/web'], { encoding: 'utf8' });
  if (dirty.stdout?.trim()) console.error(`build-dsh-web: warning: apps/web is dirty after restore:\n${dirty.stdout}`);
  else console.log('build-dsh-web: apps/web restored clean');
}
