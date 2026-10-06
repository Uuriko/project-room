// Synthetic new-agent journey through public HTTP and hosted MCP. No live service.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

const fixture = createAcceptanceFixture();
const server = createRoomServer({ store: fixture.store });
const timings = [];
let secret;
const started = performance.now();
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const http = async (path, body) => {
    const response = await fetch(origin + path, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {})
    }, body: JSON.stringify(body) });
    assert.ok(response.ok, `HTTP ${response.status} at ${path}`);
    return response.json();
  };
  const identity = await http('/api/agent-identities', { displayName: 'Fast Path QA' });
  secret = identity.secret;
  const roomId = 'fast-path-lab';
  await http('/api/agent-rooms', { roomId, title: 'Fast path lab', kind: 'personal',
    purpose: 'Local synthetic acceptance', displayName: 'Fast Path QA' });
  const rpc = async (method, params, expectProtocolError = false) => {
    const start = performance.now();
    const response = await http('/mcp', { jsonrpc: '2.0', id: crypto.randomUUID(), method, params });
    assert.equal(Boolean(response.error), expectProtocolError);
    timings.push({ operation: params?.name ?? method, ms: Math.round((performance.now() - start) * 100) / 100 });
    return response.error ?? response.result;
  };
  const call = async (name, args = {}, expectError = false) => {
    const result = await rpc('tools/call', { name, arguments: { roomId, ...args } });
    assert.equal(result.isError === true, expectError, `${name}: ${JSON.stringify(result.structuredContent)}`);
    return result.structuredContent;
  };
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fast-path-check', version: '1' } });
  const core = await rpc('tools/list', {});
  const work = await rpc('tools/list', { focus: 'work' });
  const full = await rpc('tools/list', { profile: 'full' });
  assert.ok(work.tools.some(t => t.name === 'room_begin_work'));
  const access = await call('room_check_access');
  assert.equal(access.status, 'credential_accepted');
  const messageInput = { id: 'hello-op', messageId: 'hello', body: 'Hello from the direct tools.' };
  const message = await call('room_post_message', messageInput);
  const replay = await call('room_post_message', messageInput);
  assert.equal(replay.duplicate, true);
  assert.equal(typeof message.event.id, 'string');
  assert.equal(replay.event.id, message.event.id);
  await call('room_post_message', { ...messageInput, body: 'Changed input must fail' }, true);
  await call('room_react', { id: 'robot-op', messageId: 'hello', reaction: '🤖', active: true });
  await call('room_post_message', { id: 'reply-op', messageId: 'reply', replyToId: 'hello', body: 'Thread reply, directly.' });
  // Test missing channel support rather than silently posting to the wrong place.
  const channelError = await rpc('tools/call', { name: 'room_post_message', arguments: {
    roomId, id: 'channel-op', body: 'Channel note', channelId: 'qa-lab'
  } }, true);
  assert.deepEqual(channelError.data.unexpected, ['channelId']);
  const workItemId = 'direct-task';
  await call('room_propose_work', { requestId: 'propose-op', workItemId, title: 'Produce a concise result',
    definitionOfDone: 'Result text is saved and readable with its exact hash.', accountableMemberId: access.memberId,
    mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false });
  const begin = await call('room_begin_work', { workItemId });
  const current = await call('room_read_work', { workItemId });
  assert.equal(current.work.state, 'working', JSON.stringify(begin));
  await call('room_accept_work', { requestId: 'stale-op', workItemId, expectedRevision: 0 }, true);
  const body = 'Direct-tool result: messages, reaction, thread, retries and files verified locally.';
  const draftInput = { requestId: 'draft-op', workItemId, packetId: 'result-packet', basisRevision: current.work.revision, body };
  const draft = await call('room_post_draft', draftInput);
  assert.equal((await call('room_post_draft', draftInput)).duplicate, true);
  const preview = await call('room_read_result', { workItemId, draftMessageId: draft.messageId });
  assert.equal(preview.result.text.body, body);
  const resultInput = { requestId: 'result-op', workItemId, expectedRevision: current.work.revision,
    summary: 'Synthetic direct workflow passed', nextAction: 'No external work was performed',
    evidenceMessageId: draft.messageId, evidenceMessageEventId: draft.eventId,
    evidenceVersion: 'sha256:' + createHash('sha256').update(body, 'utf8').digest('hex'),
    previousCompletionEventId: null, producerId: access.memberId };
  await call('room_submit_text_result', resultInput);
  assert.equal((await call('room_submit_text_result', resultInput)).duplicate, true);
  const saved = await call('room_read_result', { workItemId });
  assert.equal(saved.result.text.body, body);
  const bytes = Buffer.from('A synthetic file uploaded without a file picker.\n');
  await call('room_put_file', { id: 'test-file', filename: 'direct-test.txt', mediaType: 'text/plain', data: bytes.toString('base64') });
  await call('room_commit_file', { id: 'test-file', messageId: 'hello' });
  const [file, files, messages] = await Promise.all([
    call('room_get_file', { id: 'test-file' }), call('room_list_files'), call('room_read_messages', { limit: 20 })
  ]);
  assert.equal(file.attachment.data, bytes.toString('base64'));
  assert.ok(JSON.stringify(files).includes('direct-test.txt'));
  assert.ok(JSON.stringify(messages).includes(messageInput.body));
  await call('room_check_access', { roomId: 'commons' }, true);
  const completed = await call('room_read_work', { workItemId });
  assert.equal(completed.work.state, 'completed');
  console.log(JSON.stringify({ passed: true, environment: 'local synthetic HTTP/MCP; no native agent host',
    catalog: { core: core.tools.length, work: work.tools.length, full: full.tools.length },
    identityAndRoomHttpCalls: 2, mcpCalls: timings.length,
    elapsedMs: Math.round(performance.now() - started), beginWorking: begin.working,
    workState: completed.work.state,
    assertions: ['new enrollment', 'owner room', 'focused discovery', 'message', 'exact retry', 'changed retry rejected',
      'reaction', 'thread', 'channel parameter gap', 'propose', 'begin', 'stale revision rejected', 'draft', 'preview',
      'text result', 'completion retry', 'file upload/commit/read', 'parallel reads', 'other room denied'], timings }, null, 2));
} finally {
  server.closeStreams(); server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
}
