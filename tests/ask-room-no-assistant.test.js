// User test 2026-10-19 (#2): in a new room with no assistant, "Ask Room" was a
// dead end. The button showed whenever the human view was on, "@Room ..." or a
// still-pressed Ask Room routed the send to the assistant, the server answered
// 409 assistant_not_connected (the message and the ask are one transaction, so
// nothing posted), and the composer said "Draft kept. Send again to retry".
// Sending again resent the same rejected ask, forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askAvailable, askFailureHint } from '../src/human-experience.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const human = readFileSync(join(ROOT, 'src/human-experience.js'), 'utf8');
const app = readFileSync(join(ROOT, 'src/app.js'), 'utf8');

test('Ask Room is available only when the server would accept an ask', () => {
  assert.equal(askAvailable(null), false, 'no projection read yet');
  assert.equal(askAvailable({ name: 'Room', coordinatorMemberId: null, availability: 'not_connected' }), false, 'fresh room: nothing configured');
  assert.equal(askAvailable({ name: 'Room', coordinatorMemberId: 'agent-1', availability: 'not_connected' }), false, 'configured agent no longer active / lost accept_work');
  assert.equal(askAvailable({ coordinatorMemberId: 'agent-1', availability: 'connected' }), true);
  assert.equal(askAvailable({ coordinatorMemberId: 'agent-1', availability: 'awaiting_host' }), true, 'the server queues the ask for a host that is not polling yet');
  assert.equal(askAvailable({ coordinatorMemberId: 'agent-1', availability: 'paused' }), true, 'a paused host still accepts a queued ask');
});

test('a refused ask with no assistant never tells the person to send again', () => {
  const hint = askFailureHint({ status: 409, code: 'assistant_not_connected' });
  assert.doesNotMatch(hint, /send again/i);
  assert.match(hint, /Draft kept/);
  assert.match(hint, /as a message/i, 'says what Send does next');
  assert.equal(askFailureHint({ status: 503, code: 'unavailable' }), 'Draft kept. Send again to retry.', 'other failures keep the retry hint');
  assert.equal(askFailureHint(undefined), 'Draft kept. Send again to retry.');
});

test('the composer and the Ask Room button use the availability gate', () => {
  assert.match(app, /failureHint:\s*humanExperience\.askFailureHint\b/, 'message-form passes the error-aware hint');
  assert.match(human, /^\s*askFailureHint,$/m, 'installHumanExperience hands the hint to app.js (no import-block edit, so the patch also applies on top of #4050)');
  assert.doesNotMatch(app, /failureHint:\s*"Draft kept\. Send again to retry\."/, 'no unconditional retry hint on the message form');
  assert.match(app, /typeof failureHint === "function"/, 'submit() resolves a hint from the error');
  assert.match(human, /ask\.hidden = !active \|\| !askAvailable\(projection\?\.assistant\)/, 'sync hides Ask Room with no assistant');
  assert.match(human, /ask\.hidden = !askAvailable\(projection\.assistant\)/, 'paint hides Ask Room once the projection says not connected');
  assert.match(human, /if \(!contribution && !askAvailable\(projection\?\.assistant\)\) return null;/, 'intent posts a plain message when no assistant can take it');
  assert.match(human, /failure\.code === 'assistant_not_connected'/, 'a not-connected refusal drops the rejected ask so the next Send posts the message');
});
