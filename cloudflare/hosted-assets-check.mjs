// Read-only public release verification. No credentials or room mutations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assetPaths } from './build-assets.mjs';

const origin = 'https://project-room-staging.getdasha.workers.dev';
for (const file of assetPaths) {
  const response = await fetch(`${origin}/${file === 'index.html' ? '' : file}`, { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, file);
  assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(await readFile(new URL('../' + file, import.meta.url))), `Different live asset: ${file}`);
}
for (const [path, status] of [['/api/health', 200], ['/api/ready', 200], ['/api/rooms/commons', 401]]) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, status, path);
  assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
  await response.arrayBuffer();
}
console.log(`PASS: ${assetPaths.length} exact live assets; health/readiness, signed-out denial and no-index headers. No room records changed.`);
