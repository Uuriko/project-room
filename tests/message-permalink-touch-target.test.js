import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
test('timestamp permalink has a 44px target on coarse pointers and narrow screens', () => {
  const rule = css.match(/@media\s*\(pointer:\s*coarse\),\s*\(max-width:\s*500px\)\s*\{\s*\.message-time\s*\{([^}]+)\}/);
  assert.ok(rule, 'coarse and narrow viewports need a message-time rule');
  for (const dimension of ['min-width', 'min-height']) assert.match(rule[1], new RegExp(`${dimension}:\\s*44px`));
  assert.match(rule[1], /display:\s*inline-flex/);
  assert.match(rule[1], /align-items:\s*center/);
});
test('timestamp keeps its semantic link, date and existing message-open action', () => {
  assert.match(app, /<a class="message-time" href="\$\{esc\(recordHref\("message", m\.id\)\)\}" data-open-message=/);
  assert.match(app, /<time datetime="\$\{esc\(m\.createdAt\)\}">/);
});
