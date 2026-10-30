import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient } from '../client/room-agent.mjs';

function clientWithHead(head = 23000, contextRoom = 'commons') {
  const calls = [];
  const client = new RoomAgentClient({ origin: 'http://localhost:3847', roomId: 'commons', token: 'a'.repeat(43),
    fetchImpl: async url => {
      const parsed = new URL(url); calls.push(parsed.pathname + parsed.search);
      if (parsed.pathname.endsWith('/context')) return Response.json({ roomId: contextRoom, cursors: { roomSequence: head } });
      assert.ok(parsed.pathname.endsWith('/events'));
      const after = Number(parsed.searchParams.get('after')), limit = Number(parsed.searchParams.get('limit'));
      const end = Math.min(head, after + limit);
      return Response.json({ events: Array.from({ length: end - after }, (_, i) => {
        const sequence = after + i + 1;
        return { sequence, event: { type: 'message.posted', id: `e${sequence}`, actorId: 'worker', data: { messageId: `m${sequence}`, body: `message ${sequence}` } } };
      }), next: end, hasMore: end < head });
    }
  });
  return { client, calls };
}

test('latest messages use a bounded tail read beyond the forward scan ceiling', async () => {
  const { client, calls } = clientWithHead();
  const result = await client.roomMessages({ latest: true, limit: 5 });
  assert.deepEqual(result.messages.map(m => m.sequence), [22996,22997,22998,22999,23000]);
  assert.equal(result.next, 23000);
  assert.equal(result.hasMore, true);
  assert.deepEqual(calls, ['/api/rooms/commons/context', '/api/rooms/commons/events?after=22900&limit=100']);
});

test('latest at the head is empty; forward paging does not fetch context', async () => {
  const f = clientWithHead();
  assert.deepEqual((await f.client.roomMessages({ latest: true, after:23000 })).messages, []);
  assert.equal(f.calls.length,1);
  const g = clientWithHead();
  assert.equal((await g.client.roomMessages({ after:22999, limit:1 })).messages[0].sequence,23000);
  assert.equal(g.calls.length,1); assert.match(g.calls[0],/events/);
});

test('invalid or mismatched horizons fail without scanning history', async () => {
  for (const [head, room] of [[null,'commons'],[-1,'commons'],[10,'another-room']]) {
    const f = clientWithHead(head,room);
    await assert.rejects(f.client.roomMessages({latest:true}), {code:'invalid_response'});
    assert.equal(f.calls.length,1);
  }
  const f=clientWithHead(10);
  await assert.rejects(f.client.roomMessages({latest:true,after:11}),{code:'cursor_ahead'});
});
