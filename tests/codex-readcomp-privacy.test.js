import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { readWorkSelection } from '../client/work-preparation.mjs';
import { textVersion } from '../server/text-results.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

// CX3 composition gate (Codex lanes #3229 + #3295): native result text follows
// artifact-party authorization on the ACTUAL composed read paths. The evidence
// message is a DM (toMemberId) linked to the work item: its parties are the
// author and the addressee only. A third room member must get reference
// metadata at most — never the body, an excerpt, or a derived encoding of it —
// through the batch read, the discussion window, or the exact review packet.
// A non-member must not read at all.
const SECRET = 'Secret DM result body — parties only';
const PUBLIC_BODY = 'Public discussion note for the whole room';

async function setup(t) {
  const f = createAcceptanceFixture(), id = 'test-handoff';
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (type, data, actor = 'producer') => f.store.command(f.keys[actor], 'commons', { id: randomUUID(), type, data });
  const item = () => f.store.room('commons').state.workItems[id];
  const mutate = (type, data = {}, actor) => send(type, { workItemId: id, expectedRevision: item().revision, ...data }, actor);
  mutate('work.accepted'); mutate('work.started');
  // Fresh linked identities: the hosted door requires identity secrets, and
  // the DM's addressee must be one of the parties we can authenticate as.
  const linkMember = name => { const identity = f.store.identities.create(name);
    linkWithProof(f.store, f.keys.owner, 'commons', identity, { displayName: name, permissions: [] });
    return identity; };
  const party = linkMember('Party reader'), third = linkMember('Third member');
  const clientFor = (memberId, token) => new RoomAgentClient({ version: 1, origin, roomId: 'commons', memberId, token });
  // The hosted MCP door is the composed server-side read path (#3229/#3295);
  // it serves human and agent members alike, unlike the agent-only CLI ladder.
  const mcpReadWork = async (token, args) => (await (await fetch(`${origin}/room/mcp?profile=full`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cx3-privacy', method: 'tools/call', params: { name: 'room_read_work', arguments: { roomId: 'commons', ...args } } }) })).json());
  return { ...f, id, origin, send, item, mutate, clientFor, mcpReadWork, party, third,
    producer: clientFor('producer', f.keys.producer),
    reviewer: clientFor('reviewer', f.keys.reviewer) };
}

test('composed reads keep DM evidence text to its parties: batch, discussion, exact review', async t => {
  const f = await setup(t);
  // Discussion surface: one public note and one DM, both linked to the task.
  f.send('message.posted', { messageId: randomUUID(), workItemId: f.id, body: PUBLIC_BODY });
  const dm = f.send('message.posted', { messageId: randomUUID(), workItemId: f.id, body: SECRET, toMemberId: f.party.identityId });

  // Batch read (#3229) with discussion, over the hosted door: the non-party
  // sees the public note, but no trace of the DM body anywhere in the packet;
  // the addressee (a party) sees both.
  const batchOutsider = await f.mcpReadWork(f.third.secret, { workItemIds: [f.id], includeDiscussion: true });
  assert.equal(batchOutsider.result.isError ?? false, false, JSON.stringify(batchOutsider));
  assert.equal(JSON.stringify(batchOutsider.result.structuredContent).includes(SECRET), false);
  assert.equal(JSON.stringify(batchOutsider.result.structuredContent).includes(PUBLIC_BODY), true);
  const batchParty = await f.mcpReadWork(f.party.secret, { workItemIds: [f.id], includeDiscussion: true });
  assert.equal(batchParty.result.isError ?? false, false, JSON.stringify(batchParty));
  assert.equal(JSON.stringify(batchParty.result.structuredContent).includes(SECRET), true);

  // Complete the work with the DM as the native text evidence (#3295 surface).
  f.mutate('work.completed', { evidenceKind: 'room_text',
    evidenceMessageId: dm.event.data.messageId, evidenceMessageEventId: dm.event.id,
    evidenceVersion: textVersion(SECRET), previousCompletionEventId: null,
    producerId: 'producer', summary: 'DM result', nextAction: 'Review the stored text' });
  assert.equal(f.item().receipt.nativeText.messageId, dm.event.data.messageId);

  // Exact review (includeResult): the non-party is refused the whole packet and
  // the refusal carries no body; the addressee reads the exact stored text.
  const refused = await f.mcpReadWork(f.third.secret, { workItemId: f.id, includeResult: true });
  assert.ok(refused.result?.isError || refused.error, JSON.stringify(refused));
  assert.equal(JSON.stringify(refused).includes(SECRET), false);
  const guestReview = await f.mcpReadWork(f.party.secret, { workItemId: f.id, includeResult: true });
  assert.equal(guestReview.result.isError ?? false, false, JSON.stringify(guestReview));
  assert.equal(guestReview.result.structuredContent.review.result.text.body, SECRET);
  // The author reads it too, through the client-side composition.
  const authorReview = await readWorkSelection(f.producer, { workItemId: f.id, includeResult: true });
  assert.equal(authorReview.review.result.text.body, SECRET);
  // The non-party still gets the work context itself (metadata, no text): the
  // receipt stays a pointer — messageId present, body absent.
  const outsiderContext = await readWorkSelection(f.reviewer, { workItemId: f.id });
  assert.equal(outsiderContext.work.receipt.nativeText.messageId, dm.event.data.messageId);
  assert.equal(JSON.stringify(outsiderContext).includes(SECRET), false);
});

test('a non-member cannot use the composed read paths at all', async t => {
  const f = await setup(t);
  const outsider = f.store.identities.create('Unlinked outsider');
  const client = f.clientFor(outsider.identityId, outsider.secret);
  await assert.rejects(readWorkSelection(client, { workItemId: f.id }));
  await assert.rejects(readWorkSelection(client, { workItemIds: [f.id] }));
  const mcp = await f.mcpReadWork(outsider.secret, { workItemId: f.id, includeResult: true });
  assert.ok(mcp.result?.isError || mcp.error, JSON.stringify(mcp));
});
