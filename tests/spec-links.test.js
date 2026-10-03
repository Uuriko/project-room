import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract: the draft under spec/ stays internally linked, and every module
// path it cites is a file in this repository. A rename of a cited module, or
// a broken relative link, fails here. Function renames inside a cited file do
// not. docs/SPEC.md is the map into that draft.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specDir = join(root, 'spec');

const REQUIRED = [
  'README.md',
  'CHANGELOG.md',
  'rfcs/0000-template.md',
  'core/room.md',
  'core/claim.md',
  'core/receipt.md',
  'core/wake.md',
  'core/approval.md',
  'bindings/http.md',
  'bindings/mcp.md',
  'bindings/a2a.md',
];

const ROOM_TODAY = [
  ...REQUIRED.filter(name => name.startsWith('core/') || name.startsWith('bindings/')),
];

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) files.push(...walk(abs));
    else if (name.endsWith('.md')) files.push(abs);
  }
  return files;
}

function markdownFiles() {
  return walk(specDir).sort();
}

test('draft spec files exist and name version 0.1.0-draft', () => {
  const missing = REQUIRED.filter(name => !existsSync(join(specDir, name)));
  assert.deepEqual(missing, []);
  const readme = readFileSync(join(specDir, 'README.md'), 'utf8');
  assert.match(readme, /0\.1\.0-draft/);
  assert.match(readme, /CC-BY-4\.0/);
  assert.match(readme, /Apache-2\.0/);
  assert.match(readme, /RFC 2119/);
  const changelog = readFileSync(join(specDir, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /0\.1\.0-draft/);
});

test('spec markdown is lint-clean enough to cite', () => {
  const problems = [];
  for (const abs of markdownFiles()) {
    const rel = relative(specDir, abs);
    const text = readFileSync(abs, 'utf8');
    if (!text.endsWith('\n')) problems.push(`${rel}: missing final newline`);
    if (!text.startsWith('# ')) problems.push(`${rel}: does not open with a heading`);
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (/[ \t]+$/.test(line)) problems.push(`${rel}:${index + 1}: trailing whitespace`);
    });
    if (/coming soon/i.test(text)) problems.push(`${rel}: says "coming soon"`);
  }
  for (const name of ROOM_TODAY) {
    const text = readFileSync(join(specDir, name), 'utf8');
    if (!/\bMUST\b/.test(text)) problems.push(`${name}: no RFC 2119 MUST`);
    if (!text.includes('Room today')) problems.push(`${name}: no Room today note`);
  }
  assert.deepEqual(problems, []);
});

test('relative links in spec/ and docs/SPEC.md resolve', () => {
  const broken = [];
  const files = [
    ...markdownFiles(),
    join(root, 'docs', 'SPEC.md'),
  ];
  for (const abs of files) {
    const text = readFileSync(abs, 'utf8');
    const rel = relative(root, abs);
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].trim().replace(/^<|>$/g, '');
      if (!raw || raw.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) continue;
      const target = decodeURIComponent(raw.split('#')[0].split('?')[0]);
      if (!target) continue;
      const resolved = resolve(dirname(abs), target);
      if (!existsSync(resolved)) broken.push(`${rel}: ${raw}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('module paths cited in spec/ exist', () => {
  const missing = [];
  const cited = /`((?:server|src|cloudflare|docs|deploy|scripts|spec)\/[A-Za-z0-9_./-]+\.(?:mjs|js|md|yaml))`/g;
  for (const abs of markdownFiles()) {
    const text = readFileSync(abs, 'utf8');
    const rel = relative(specDir, abs);
    for (const match of text.matchAll(cited)) {
      const citedPath = match[1];
      if (!existsSync(join(root, citedPath))) missing.push(`${rel}: ${citedPath}`);
    }
  }
  assert.deepEqual(missing, []);
  const claim = readFileSync(join(specDir, 'core', 'claim.md'), 'utf8');
  assert.match(claim, /`server\/work-claims\.mjs`/);
  assert.match(claim, /`server\/work-claim-routes\.mjs`/);
});

test('docs/SPEC.md points at the draft spec', () => {
  const text = readFileSync(join(root, 'docs', 'SPEC.md'), 'utf8');
  assert.match(text, /\.\.\/spec\/README\.md/);
  assert.match(text, /0\.1\.0-draft/);
  assert.equal(existsSync(join(root, 'spec', 'README.md')), true);
});
