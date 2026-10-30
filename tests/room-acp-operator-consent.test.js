import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../room-acp/src/bridge.mjs';
import { parseArgs } from '../room-acp/src/args.mjs';
import { run } from '../room-acp/src/run.mjs';
import { loadConnection, saveConnection } from '../room-acp/src/credentials.mjs';

function fixture(permissionApproverId) {
  const logs = [];
  const bridge = new Bridge({ connection: { apiBase: 'http://localhost', roomId: 'r', memberId: 'agent', hostId: 'h', permissionApproverId }, persistSessions: false, host: {}, log: line => logs.push(line) });
  const members = { sponsor: { id: 'sponsor', kind: 'human', active: true }, operator: { id: 'operator', kind: 'human', active: true }, agent: { id: 'agent', kind: 'agent', accountableHumanId: 'sponsor', active: true } };
  bridge.room.room = async () => ({ state: { room: { ownerId: 'sponsor' }, members } });
  bridge.fencingToken = 'test-fence';
  bridge.room.checkListener = async () => ({ listener: { valid: true } });
  return { bridge, logs, members };
}

test('invitation sponsor never implicitly gains local tool approval authority', async () => {
  const { bridge, logs } = fixture();
  let roomCalls = 0;
  bridge.room.room = async () => { roomCalls++; throw Error('must not ask sponsor'); };
  assert.deepEqual(await bridge.onPermission({}), { outcome: { outcome: 'cancelled' } });
  assert.equal(roomCalls, 0);
  assert.match(logs[0], /disabled.*--permission-approver/);
});

test('explicit local approver stays bound; validation fails on membership removal', async () => {
  const { bridge, members } = fixture('operator');
  await bridge.refreshRoom();
  let validation, signal;
  bridge.permissions.request = async (request, currentSignal) => { validation = request.validateApproval; signal = currentSignal; return {}; };
  await bridge.onPermission({});
  assert.equal(bridge.permissions.approverId, 'operator');
  members.agent.accountableHumanId = 'someone-else';
  assert.equal(await validation(), true);
  assert.equal(bridge.permissions.approverId, 'operator');
  members.operator.active = false;
  assert.equal(await validation(), false);
  assert.equal(signal.aborted, true);
});

test('local approver must be a current human, never an agent or missing member', async () => {
  for (const id of ['missing', 'agent']) {
    const { bridge, logs } = fixture(id);
    assert.deepEqual(await bridge.onPermission({}), { outcome: { outcome: 'cancelled' } });
    assert.match(logs[0], /not an active human/);
  }
});

test('operator flag persists across restart and none explicitly revokes it', async t => {
  const home = mkdtempSync(join(tmpdir(), 'operator-consent-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ROOM_ACP_HOME: home };
  saveConnection({ apiBase: 'http://localhost', roomId: 'r', memberId: 'agent', credential: 'private-fixture', hostId: 'h' }, env);
  const seen = [], lines = [];
  const io = { env, print: line => lines.push(line), candidate: { label: 'fake' }, onBridge: bridge => { seen.push(bridge.permissionApproverId); bridge.run = async () => 'stopped'; } };
  assert.equal(await run(parseArgs(['run', '--permission-approver', 'operator']), io), 0);
  assert.equal(loadConnection({}, env).permissionApproverId, 'operator');
  assert.equal(await run(parseArgs(['run']), io), 0);
  assert.equal(await run(parseArgs(['run', '--permission-approver', 'none']), io), 0);
  assert.equal(loadConnection({}, env).permissionApproverId, null);
  assert.deepEqual(seen, ['operator', 'operator', null]);
  assert.ok(lines.some(line => /Room approvals disabled/.test(line)));
  assert.throws(() => parseArgs(['run', '--permission-approver', 'display name']), /exact member ID/);
  assert.throws(() => parseArgs(['run', '--permission-approver']), /needs a value/);
});
