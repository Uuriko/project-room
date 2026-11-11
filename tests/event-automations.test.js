import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createWork, claimWork } from '../server/work-claims.mjs';
import { emitWorkClaimEvent } from '../server/work-claim-events.mjs';
import { runAutomations, matches, validTrigger, createRule, setRuleEnabled, AUTOMATION_TEMPLATES, POST_DEPLOY_BRIEF } from '../server/event-automations.mjs';

function withFlag(t, value) {
  const old = process.env.ROOM_AUTOMATIONS;
  if (value === undefined) delete process.env.ROOM_AUTOMATIONS; else process.env.ROOM_AUTOMATIONS = value;
  t.after(() => { if (old === undefined) delete process.env.ROOM_AUTOMATIONS; else process.env.ROOM_AUTOMATIONS = old; });
}
function freshStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'room-automations-'));
  const store = new RoomStore(join(directory, 'room.sqlite')); store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test('trigger validation and matching', () => {
  assert.equal(validTrigger({}), false, 'match-everything rules are refused');
  assert.equal(validTrigger({ kinds: ['deploy'], bogus: 1 }), false);
  assert.equal(validTrigger({ actions: ['not_an_action'] }), false);
  assert.equal(validTrigger(AUTOMATION_TEMPLATES['post-deploy-check'].trigger), true);
  const trig = AUTOMATION_TEMPLATES['post-deploy-check'].trigger;
  assert.equal(matches(trig, { action: 'state_changed', kind: 'deploy', claimState: 'done' }), true);
  assert.equal(matches(trig, { action: 'state_changed', kind: 'land', claimState: 'done' }), false);
  assert.equal(matches(trig, { action: 'state_changed', claimState: 'done' }), false, 'plain work is kind work');
  assert.equal(matches({ tags: ['sev1'] }, { action: 'created' }, ['sev1']), true);
});

test('post-deploy template wakes the assigned agent once per event; off by default; no loops', t => {
  const store = freshStore(t);
  const deploy = (id, state) => ({ ...createWork({ id, title: 'Deploy main', kind: 'deploy', revision: 'abc123' }, { now: 1, agentId: 'owner' }), state });
  const wakes = [];
  const deps = { createWork, claimWork, emitWorkClaimEvent, enqueueClaimWake: (_s, _r, member, messageId) => { wakes.push({ member, messageId }); return { enqueued: true }; } };
  const tpl = AUTOMATION_TEMPLATES['post-deploy-check'];
  const { rule } = createRule(store.db, { roomId: 'commons', name: tpl.name, trigger: tpl.trigger, action: tpl.action('owner'), template: 'post-deploy-check', createdBy: 'owner' });
  assert.equal(rule.enabled, false); assert.equal(rule.action.brief, POST_DEPLOY_BRIEF);
  const ev = { id: 'e1', data: { action: 'state_changed', kind: 'deploy', claimState: 'done' } };
  withFlag(t, undefined);
  setRuleEnabled(store.db, { roomId: 'commons', ruleId: rule.ruleId, enabled: true });
  assert.deepEqual(runAutomations(store, 'commons', ev, deploy('d1', 'done'), deps), [], 'flag off: nothing runs');
  process.env.ROOM_AUTOMATIONS = '1';
  setRuleEnabled(store.db, { roomId: 'commons', ruleId: rule.ruleId, enabled: false });
  assert.deepEqual(runAutomations(store, 'commons', ev, deploy('d1', 'done'), deps), [], 'disabled rule: nothing runs');
  setRuleEnabled(store.db, { roomId: 'commons', ruleId: rule.ruleId, enabled: true });
  assert.equal(runAutomations(store, 'commons', ev, deploy('d1', 'done'), deps)[0].result, 'woke');
  assert.equal(wakes.length, 1); assert.equal(wakes[0].member, 'owner'); assert.match(wakes[0].messageId, /^work-claim:d1:automation:/);
  assert.deepEqual(runAutomations(store, 'commons', ev, deploy('d1', 'done'), deps), [], 'same event runs once');
  assert.deepEqual(runAutomations(store, 'commons', { id: 'e2', data: { action: 'state_changed', kind: 'deploy', claimState: 'done' } },
    { ...deploy('d2', 'done'), tags: ['automation'] }, deps), [], 'automation-made items never trigger');
});

test('open_task action opens one Board task per event through the real event path', t => {
  const store = freshStore(t);
  withFlag(t, '1');
  const { rule } = createRule(store.db, { roomId: 'commons', name: 'Blocked follow-up', trigger: { actions: ['state_changed'], states: ['blocked'] },
    action: { type: 'open_task', title: 'Unblock follow-up', assignee: 'owner' }, createdBy: 'owner' });
  setRuleEnabled(store.db, { roomId: 'commons', ruleId: rule.ruleId, enabled: true });
  const item = { ...createWork({ id: 'w1', title: 'Work' }, { now: 1, agentId: 'owner' }), state: 'blocked' };
  store.workClaims.set('commons', item);
  emitWorkClaimEvent(store, 'commons', { actorId: 'owner', item, action: 'state_changed', previousState: 'open' });
  const opened = store.workClaims.list('commons').filter(c => c.tags?.includes('automation'));
  assert.equal(opened.length, 1); assert.equal(opened[0].owner, 'owner'); assert.equal(opened[0].title, 'Unblock follow-up');
});

test('admin route: owner only, flag-gated after auth, template creates a disabled rule', async t => {
  const store = freshStore(t);
  const server = createRoomServer({ store }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = store.issueAccessKey('commons', 'owner');
  const admin = (data, auth = token) => fetch(`${origin}/api/rooms/commons/automations`, { method: 'POST',
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  withFlag(t, undefined);
  assert.equal((await admin({ list: true }, null)).status, 401);
  assert.equal((await admin({ list: true })).status, 404);
  process.env.ROOM_AUTOMATIONS = '1';
  assert.equal((await admin({ template: 'nope' })).status, 422);
  assert.equal((await admin({ create: { name: 'x', trigger: {}, action: { type: 'wake', member: 'owner', brief: 'b' } } })).status, 422);
  const made = await admin({ template: 'post-deploy-check' }); assert.equal(made.status, 201);
  const { rule } = await made.json(); assert.equal(rule.enabled, false); assert.equal(rule.template, 'post-deploy-check');
  assert.equal((await admin({ enable: rule.ruleId })).status, 200);
  const listed = await (await admin({ list: true })).json();
  assert.equal(listed.rules[0].enabled, true); assert.deepEqual(listed.templates, ['post-deploy-check']);
  assert.equal((await admin({ delete: rule.ruleId })).status, 200);
  assert.equal((await admin({ enable: rule.ruleId })).status, 404);
});

test('trigger states are the real claim states', () => {
  assert.equal(validTrigger({ states: ['closed', 'unclaimed'] }), true);
  assert.equal(validTrigger({ states: ['cancelled'] }), false);
});

test('automation routes are registered rows with parity notes', async () => {
  const { AUTOMATION_ROUTES } = await import('../server/routes/automations.mjs');
  assert.ok(AUTOMATION_ROUTES.length > 0);
  for (const row of AUTOMATION_ROUTES) assert.ok(row.id && row.method && row.path && row.parity, row.id);
});
