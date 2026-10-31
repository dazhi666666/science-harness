#!/usr/bin/env node
// Sync Agent Router from its source checkout into integrations/agent-router/.
//
// The source checkout is the only place Agent Router code is edited
// (AGENT_ROUTER_SOURCE, default D:\Agent-Router); this repository only ever
// copies from it. The sync exports the committed HEAD via `git archive`
// — content equals the last commit, line endings come out as LF, and
// uncommitted edits cannot leak over — then mirrors it onto the target.
//
// Never copied: dsh-web/ (43MB captured frontend build, rebuilt locally),
// runtime data and machine-local config (gitignored upstream, so archive
// never carries them). Never overwritten or deleted here: harness/ and
// package.json (this repository's own adapter layer and manifest).
//
// Usage: node scripts/sync-agent-router.mjs [--check]
//   --check  verify only: report drift, change nothing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHECK_ONLY = process.argv.includes('--check');
const SOURCE = process.env.AGENT_ROUTER_SOURCE || 'D:/Agent-Router';
const TARGET = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'integrations', 'agent-router');
// Top-level entries from the source that must not land in the target.
const EXCLUDE = new Set(['dsh-web']);
// Target-only entries the sync must not overwrite or delete.
const KEEP_LOCAL = new Set(['harness', 'package.json', 'router.config.json']);

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');
function walk(root, fn) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

// The source checkout has no .gitattributes and stores CRLF blobs, while this
// repository is an eol=lf checkout: normalize text content to LF on read so
// the comparison and the written files match the target convention.
function readNormalized(file) {
  const buf = fs.readFileSync(file);
  if (!buf.includes(0x0d) || buf.includes(0)) return buf;
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function collect(root, skip) {
  const files = new Map();
  if (!fs.existsSync(root)) return files;
  walk(root, p => {
    const r = rel(root, p);
    if (skip.has(r.split('/')[0])) return;
    files.set(r, readNormalized(p));
  });
  return files;
}

if (!fs.existsSync(path.join(SOURCE, '.git'))) {
  console.error(`sync-agent-router: source checkout not found: ${SOURCE}`);
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-router-sync-'));
try {
  execFileSync('git', ['-C', SOURCE, 'archive', '--format=tar', '--output', path.join(tmp, 'ar.tar'), 'HEAD']);
  const tree = path.join(tmp, 'tree');
  fs.mkdirSync(tree);
  execFileSync('tar', ['-xf', 'ar.tar', '-C', 'tree'], { cwd: tmp });

  const source = collect(tree, EXCLUDE);
  const target = collect(TARGET, new Set([...EXCLUDE, ...KEEP_LOCAL, 'data', 'deepseek-harness', 'node_modules', '.zcode', '.agents', '.tmp-capture']));

  if (CHECK_ONLY) {
    const drift = [];
    for (const [r, buf] of source) if (!target.get(r)?.equals(buf)) drift.push(`outdated/missing: ${r}`);
    for (const r of target.keys()) if (!source.has(r)) drift.push(`extra: ${r}`);
    if (drift.length) { console.error(`sync-agent-router: ${drift.length} drifted file(s)\n${drift.map(d => `  ${d}`).join('\n')}`); process.exit(1); }
    console.log('sync-agent-router: target matches source HEAD');
    process.exit(0);
  }

  let updated = 0;
  for (const [r, buf] of source) {
    const dest = path.join(TARGET, r);
    if (target.get(r)?.equals(buf)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    updated++;
  }
  let removed = 0;
  for (const r of target.keys()) {
    if (source.has(r)) continue;
    fs.rmSync(path.join(TARGET, r));
    removed++;
  }
  // Prune now-empty directories the removal left behind.
  const prune = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        prune(path.join(dir, entry.name));
        if (!fs.readdirSync(path.join(dir, entry.name)).length) fs.rmdirSync(path.join(dir, entry.name));
      }
    }
  };
  prune(TARGET);
  console.log(`sync-agent-router: ${updated} file(s) written, ${removed} removed (source: ${SOURCE} @ HEAD)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
