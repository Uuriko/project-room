// Opt-in live qualification. Uses an existing dedicated, authenticated profile.
// One synthetic model request; local Room only. Never copy operator credentials.
// Usage: node scripts/qualify-codex-room.mjs /absolute/runtime.json /absolute/report.json
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createRoomClient } from '../client/room-assistant-client.mjs';
import { openRequestJournal } from '../client/request-runner.mjs';
import { openCodexStdio, validateCodexRuntimeConfig, checkCodexProtocol } from '../client/codex-stdio.mjs';
import { runCodexSharedAssistant } from '../client/codex-shared-assistant.mjs';

const [configPath, reportPath, mode] = process.argv.slice(2);
const disconnectAfterStart = mode === "--disconnect-after-start";
if ((process.argv.length !== 4 && !(process.argv.length === 5 && disconnectAfterStart)) || !isAbsolute(configPath ?? '') || !isAbsolute(reportPath ?? ''))
  throw new Error('Explicit absolute runtime config and report paths required');
const f = createAcceptanceFixture({ dmConsent: true });
const workspace = join(realpathSync(f.directory), 'provider-workspace');
mkdirSync(workspace, { mode: 0o700 });
writeFileSync(join(workspace, 'AGENTS.md'), 'Disposable protocol qualification. No tools, network, file changes or delegation are needed. Answer the synthetic request only.\n');
const config = validateCodexRuntimeConfig({ ...JSON.parse(readFileSync(configPath, 'utf8')),
  cwd: workspace, policy: { approvalPolicy: 'never', sandbox: 'read-only' } });
const journal = join(f.directory, 'host-journal.sqlite');
const server = createRoomServer({ store: f.store });
let db, rpc;
const calls = [];
const open = () => {
  db = openRequestJournal(journal);
  const threads = db.prepare("SELECT 1 FROM sqlite_master WHERE name='codex_runtime_attempts'").get()
    ? db.prepare('SELECT thread_id FROM codex_runtime_attempts WHERE thread_id IS NOT NULL').all().map(r => r.thread_id) : [];
  rpc = openCodexStdio(config, { allowedThreadIds: threads });
  return { ...rpc, async request(method, ...args) {
    calls.push(method);
    const value = await rpc.request(method, ...args);
    if (disconnectAfterStart && method === 'turn/start') await rpc.close();
    return value;
  } };
};
const report = { version: 1, platform: process.platform, arch: process.arch, node: process.version,
  modelTurnExecuted: false, protocolReady: false, publication: false, hostRestartRetry: false,
  physicalSleepTested: false, productionAccess: false };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = { version: 1, origin: `http://127.0.0.1:${server.address().port}`,
    roomId: 'commons', memberId: 'producer', token: f.keys.producer };
  const owner = createRoomClient({ ...connection, token: f.keys.owner });
  await owner.act({ action: 'configure', requestId: 'qualification-config', expectedRevision: 0,
    name: 'Room', coordinatorMemberId: 'producer' });
  f.store.command(f.keys.owner, 'commons', { id: 'qualification-question', type: 'message.posted',
    data: { messageId: 'qualification-question', body: 'Synthetic transport check. Return only ROOM-QUALIFIED-42. Do not use tools.' } });
  await owner.act({ action: 'invoke', requestId: 'qualification-invoke', runId: 'qualification', sourceMessageId: 'qualification-question' });
  let measuredRpc = open();
  await checkCodexProtocol(measuredRpc, config); report.protocolReady = true;
  const run = () => runCodexSharedAssistant({ connection, db, rpc: measuredRpc, cwd: config.cwd,
    policy: config.policy, runId: 'qualification', timeoutMs: disconnectAfterStart ? 3000 : config.turnTimeoutMs });
  if (disconnectAfterStart) {
    // Drop the real process after start acknowledgement, before publication.
    // The durable turn identifier must be reconciled, never blindly restarted.
    await assert.rejects(run());
    await rpc.close(); rpc = null; db.close(); db = null;
    measuredRpc = open();
    let recovered = null;
    try { recovered = await run(); } catch (error) {
      assert.match(error.message, /recovery required|uncertain|unavailable|not completed|not found/i);
    }
    assert.equal(calls.filter(m => m === 'turn/start').length, 1);
    const records = db.prepare('SELECT state FROM codex_runtime_attempts').all();
    assert.equal(records.length, 1);
    report.modelTurnExecuted = true;
    report.inFlightDisconnect = true;
    report.duplicateExecutionPrevented = true;
    report.reconciledState = records[0].state;
    report.recoveredPublication = recovered?.result?.status === 'done';
    report.modelStarts = 1;
    report.status = 'passed';
  } else {
  const first = await run();
  assert.equal(first.result.status, 'done');
  const resultId = first.result.resultMessageId;
  const message = f.store.room('commons').state.messages.find(m => m.id === resultId);
  assert.match(message?.body ?? '', /ROOM-QUALIFIED-42/);
  report.modelTurnExecuted = true; report.publication = true;
  const starts = calls.filter(m => m === 'turn/start').length;
  assert.equal(starts, 1, 'one model turn must produce the answer');
  await rpc.close(); rpc = null; db.close(); db = null;
  measuredRpc = open();
  const threads = db.prepare('SELECT thread_id FROM codex_runtime_attempts WHERE thread_id IS NOT NULL').all();
  await checkCodexProtocol(measuredRpc, config, { threadId: threads[0].thread_id });
  const retry = await run();
  assert.equal(retry.result.resultMessageId, resultId);
  assert.equal(calls.filter(m => m === 'turn/start').length, starts, 'restart retry must not execute a second model turn');
  assert.equal(f.store.room('commons').state.messages.filter(m => m.id === resultId).length, 1);
  report.hostRestartRetry = true; report.modelStarts = starts;
  report.status = 'passed';
  }
} catch (error) {
  report.status = 'failed';
  // Deliberately no runtime stdout, credentials, prompts or diagnostic text in report.
  report.failureClass = error.name;
  process.exitCode = 1;
} finally {
  await rpc?.close(); db?.close();
  server.closeStreams(); server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  f.store.close();
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
  // Retain the private fixture and journal for reconciliation if a turn was ambiguous.
  console.error(`Private qualification fixture retained at ${f.directory}`);
}
