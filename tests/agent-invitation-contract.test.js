import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentInviteHandoff } from '../src/agent-invite-ui.js';

const html = readFileSync(new URL('../join.html', import.meta.url), 'utf8');
test('agent invitation keeps browser identity creation behind an explicit advanced disclosure', () => {
  const advanced = html.match(/<details id="join-browser-alternative"[^>]*>[\s\S]*?<\/details>/)?.[0];
  assert.ok(advanced, 'browser alternative is separate and collapsed');
  assert.doesNotMatch(advanced.match(/^<details[^>]*>/)[0], /\bopen\b/);
  assert.match(advanced, /id="join-form"/);
  assert.match(advanced, /single-use invitation/);
  assert.ok(html.indexOf('id="join-existing-agent-copy"') < html.indexOf('id="join-browser-alternative"'));
  assert.match(html, /class="skip-link" href="#main"/);
  assert.match(html, /id="join-loading"[^>]*role="status"/);
});

test('one portable invitation serves Dot and Codex without launching a replacement agent', () => {
  const handoff = agentInviteHandoff('RM-EXAMPLE', { origin: 'https://room.example', pathname: '/' });
  assert.match(handoff.hosted, /Dot/);
  assert.match(handoff.hosted, /Codex/);
  assert.match(handoff.hosted, /existing agent/i);
  assert.match(handoff.hosted, /detect|inspect/i);
  assert.match(handoff.hosted, /reuse/i);
  assert.match(handoff.hosted, /same request/i);
  assert.match(handoff.hosted, /room_check_access/);
  assert.match(handoff.hosted, /exact.*room|room.*exact/i);
  assert.match(handoff.hosted, /approval|consent/);
  assert.match(handoff.hosted, /unsupported|unavailable/);
  assert.match(handoff.hosted, /wake/);
  assert.match(handoff.hosted, /do not claim work automatically/i);
  assert.doesNotMatch(handoff.hosted, /codex:\/\/|pri_|Bearer |npx /);
  assert.equal(handoff.hosted.split(handoff.link).length - 1, 1);
});

// The clipboard handler only updates text, so this live region must not
// inherit .form-status:not(.visible) display:none.
test('copy feedback remains a visible polite status for success and manual fallback', () => {
  const status = html.match(/<p id="join-existing-agent-status"[^>]*>/)?.[0];
  assert.match(status, /class="[^"]*\bvisible\b[^"]*"/);
  assert.match(status, /role="status"/);
  assert.match(status, /aria-live="polite"/);
});
