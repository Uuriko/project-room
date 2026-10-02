import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

// Other in-flight batches own these names. INDEX links them now; absence is
// pending, not a broken link. A link to any other missing file still fails.
const OPTIONAL_MISSING = new Set([
  'CLAUDE-CHANNEL.md',
  'CONNECT-RECEIVE.md',
  'WORK-CLAIMS.md',
  'QA2-SYSTEMS.md',
]);

// Check committed local file links, not URLs, fragments, or bare prose references.
test('relative Markdown links in docs point to committed files', () => {
  const broken = [];
  for (const file of readdirSync(docs).filter(name => name.endsWith('.md'))) {
    const text = readFileSync(join(docs, file), 'utf8');
    const links = /!?\[[^\]]*\]\(([^)]+)\)/g;
    for (const match of text.matchAll(links)) {
      const raw = match[1].trim().replace(/^<|>$/g, '');
      if (!raw || raw.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) continue;
      const target = decodeURIComponent(raw.split('#')[0].split('?')[0]);
      if (!target || target.startsWith('/')) continue;
      const abs = resolve(docs, file, '..', target);
      if (existsSync(abs)) continue;
      if (OPTIONAL_MISSING.has(relative(docs, abs))) continue;
      broken.push(`${file}: ${raw}`);
    }
  }
  assert.deepEqual(broken, [], `Broken local documentation links:\n${broken.join('\n')}`);
});
