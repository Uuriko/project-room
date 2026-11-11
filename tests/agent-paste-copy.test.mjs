import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { agentPages, PASTE_PAGE } from '../scripts/build-agent-docs.mjs';
import { AGENT_PASTE_COPY_HASH, AGENT_PASTE_COPY_SCRIPT } from '../server/agent-paste-copy.mjs';
import { publicSearchPageCsp } from '../server/public-search.mjs';

test('paste page has per-prompt copy controls and narrowly authorizes its script', () => {
  const html = agentPages().get(PASTE_PAGE.htmlFile);
  const fields = [...html.matchAll(/<textarea id="([^"]+)"/g)].map(m => m[1]);
  assert.ok(fields.length);
  for (const id of fields) {
    assert.ok(html.includes(`data-copy-prompt="${id}" hidden`));
    assert.ok(html.includes(`id="${id}-status" role="status"`));
  }
  assert.match(html, /<details class="prompt-preview"><summary>View prompt<\/summary><textarea/);
  assert.ok(html.includes(`<script>${AGENT_PASTE_COPY_SCRIPT}</script>`));
  assert.ok(publicSearchPageCsp(PASTE_PAGE.docsPath, 'https://example.com').includes(`'sha256-${AGENT_PASTE_COPY_HASH}'`));
  assert.ok(!publicSearchPageCsp('/docs/agents', 'https://example.com').includes(AGENT_PASTE_COPY_HASH));
});

for (const available of [true, false]) test(`copy prompt ${available ? 'succeeds' : 'falls back to selection'}`, async () => {
  let click, copied, focused = false, selected = false;
  const preview = { open: false };
  const field = { value: 'the exact prompt', closest: () => preview, focus() { focused = true; }, select() { selected = true; } };
  const status = { textContent: '' };
  const button = { dataset: { copyPrompt: 'prompt' }, hidden: true, disabled: false, addEventListener(_event, handler) { click = handler; } };
  const document = { querySelectorAll: () => [button], getElementById: id => id === 'prompt' ? field : status };
  const navigator = available ? { clipboard: { writeText: async text => { copied = text; } } } : {};
  runInNewContext(AGENT_PASTE_COPY_SCRIPT, { document, navigator, setTimeout });
  assert.equal(button.hidden, false);
  await click();
  assert.equal(button.disabled, false);
  if (available) { assert.equal(copied, field.value); assert.match(status.textContent, /^Copied/); }
  else { assert.ok(preview.open && focused && selected); assert.match(status.textContent, /^Copy the selected/); }
});

test('agent directory lists each local setup guide once', async () => {
  const { connectSnippets } = await import('../server/connect-snippets.mjs');
  const html = agentPages().get('docs/agents/index.html');
  for (const tool of connectSnippets) {
    assert.equal(html.split(`href="${tool.docsPath}"`).length - 1, 1, tool.docsPath);
  }
});
