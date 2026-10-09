// slack-adapter.test.mjs — tests for the Slack bot adapter prototype.
// Runs against FakeSlack only: no network, no real workspace, no tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSlack, FAKE_TOKEN, FAKE_BOT_USER } from './fake-slack.mjs';
import { roomEventToSlack, escapeMrkdwn, supportedEventTypes } from './event-map.mjs';
import { slackEventToRoom, verifySlackSignature, FAKE_SIGNING_SECRET } from './inbound-map.mjs';
import { SlackBot } from './bot.mjs';

function makeFake() {
  return new FakeSlack({ token: FAKE_TOKEN })
    .addChannel({ id: 'C-ROOM', name: 'room' })
    .addUser({ id: 'U-ALICE', name: 'alice', real_name: 'Alice' });
}

const CTX = { channel: 'C-ROOM', threadMap: new Map(), directory: new Map([['alice', { slackId: 'U-ALICE', displayName: 'Alice' }]]) };

// ---------- FakeSlack ----------

test('fake rejects a wrong token on every method', async () => {
  const fake = new FakeSlack({ token: 'xoxb-real-looking' });
  assert.equal((await fake.authTest()).error, 'invalid_auth');
  assert.equal((await fake.conversationsList()).error, 'invalid_auth');
  assert.equal((await fake.usersList()).error, 'invalid_auth');
  assert.equal((await fake.chatPostMessage({ channel: 'C', text: 'hi' })).error, 'invalid_auth');
  assert.equal((await fake.chatUpdate({ channel: 'C', ts: '1', text: 'x' })).error, 'invalid_auth');
  assert.equal((await fake.chatDelete({ channel: 'C', ts: '1' })).error, 'invalid_auth');
  assert.equal((await fake.reactionsAdd({ channel: 'C', timestamp: '1', name: 'thumbsup' })).error, 'invalid_auth');
});

test('fake posts, updates, deletes, reacts', async () => {
  const fake = makeFake();
  const post = await fake.chatPostMessage({ channel: 'C-ROOM', text: 'hello' });
  assert.equal(post.ok, true);
  assert.match(post.ts, /^\d+\.\d+$/);

  const upd = await fake.chatUpdate({ channel: 'C-ROOM', ts: post.ts, text: 'hello!' });
  assert.equal(upd.ok, true);
  assert.equal(fake.messages('C-ROOM')[0].text, 'hello!');
  assert.ok(fake.messages('C-ROOM')[0].edited);

  const react = await fake.reactionsAdd({ channel: 'C-ROOM', timestamp: post.ts, name: 'thumbsup' });
  assert.equal(react.ok, true);
  assert.equal(fake.messages('C-ROOM')[0].reactions[0].name, 'thumbsup');
  await fake.reactionsAdd({ channel: 'C-ROOM', timestamp: post.ts, name: 'thumbsup' });
  assert.equal(fake.messages('C-ROOM')[0].reactions[0].count, 2);

  const del = await fake.chatDelete({ channel: 'C-ROOM', ts: post.ts });
  assert.equal(del.ok, true);
  assert.equal(fake.messages('C-ROOM').length, 0);
});

test('fake error paths mirror Slack error names', async () => {
  const fake = makeFake();
  assert.equal((await fake.chatPostMessage({ channel: 'C-NOPE', text: 'x' })).error, 'channel_not_found');
  assert.equal((await fake.chatPostMessage({ channel: 'C-ROOM' })).error, 'no_text');
  assert.equal((await fake.chatUpdate({ channel: 'C-ROOM', ts: '9.9', text: 'x' })).error, 'message_not_found');
  assert.equal((await fake.chatDelete({ channel: 'C-ROOM', ts: '9.9' })).error, 'message_not_found');
  assert.equal((await fake.reactionsAdd({ channel: 'C-ROOM', timestamp: '9.9', name: 'x' })).error, 'message_not_found');
});

test('fake auth.test reports the fake bot identity', async () => {
  const fake = makeFake();
  const auth = await fake.authTest();
  assert.equal(auth.ok, true);
  assert.equal(auth.user_id, FAKE_BOT_USER);
});

// ---------- event-map ----------

test('message.posted maps to a Block Kit section with author + body', () => {
  const p = roomEventToSlack(
    { id: 'e1', sequence: 1, type: 'message.posted', actorId: 'alice', at: '2026-10-09T00:00:00Z', data: { authorId: 'alice', body: 'ship it' } },
    CTX,
  );
  assert.equal(p.channel, 'C-ROOM');
  assert.ok(p.text.includes('Alice') && p.text.includes('ship it'));
  assert.equal(p.blocks[0].type, 'section');
  assert.equal(p._meta.mappedAs, 'mapped');
});

test('mrkdwn special chars are escaped', () => {
  assert.equal(escapeMrkdwn('a & b <c>'), 'a &amp; b &lt;c&gt;');
  const p = roomEventToSlack(
    { id: 'e2', sequence: 2, type: 'message.posted', actorId: 'x', data: { body: '<@U1> & "quotes"' } },
    CTX,
  );
  assert.ok(!p.text.includes('<@U1>'));
  assert.ok(p.text.includes('&lt;@U1&gt;'));
});

test('thread_reply lands in the Slack thread of the parent room event', () => {
  const threadMap = new Map([['parent-1', '1728000000.000123']]);
  const p = roomEventToSlack(
    { id: 'e3', sequence: 3, type: 'thread_reply', actorId: 'alice', data: { body: 'reply', replyToId: 'parent-1' } },
    { ...CTX, threadMap },
  );
  assert.equal(p.thread_ts, '1728000000.000123');
});

test('claim events map with files and state', () => {
  const p = roomEventToSlack(
    { id: 'e4', sequence: 4, type: 'work.claimed', actorId: 'alice', data: { taskId: 'RC-1', files: ['a.mjs', 'b.mjs'] } },
    CTX,
  );
  assert.ok(p.text.includes('RC-1'));
  assert.ok(p.text.includes('a.mjs'));
});

test('bond, dm, member, verification, owner decision map without throwing', () => {
  const cases = [
    ['bond.proposed', { amount: '5' }],
    ['dm.posted', { authorId: 'alice', body: 'secret' }],
    ['member.access_changed', { memberId: 'carol', action: 'granted' }],
    ['verification.pass', { check: 'unit' }],
    ['owner.decision', { decision: 'approve' }],
  ];
  for (const [type, data] of cases) {
    const p = roomEventToSlack({ id: `x-${type}`, sequence: 1, type, actorId: 'alice', data }, CTX);
    assert.ok(p.text.length > 0, type);
    assert.ok(Array.isArray(p.blocks) && p.blocks.length > 0, type);
  }
});

test('unknown event type gets a compact fallback card, never a throw', () => {
  const p = roomEventToSlack({ id: 'e9', sequence: 9, type: 'future.event.v99', actorId: 'alice', data: {} }, CTX);
  assert.equal(p._meta.mappedAs, 'fallback');
  assert.ok(p.text.includes('future.event.v99'));
  assert.ok(!('thread_ts' in p), 'fallbacks are not threaded');
});

test('malformed event throws TypeError', () => {
  assert.throws(() => roomEventToSlack(null, CTX), TypeError);
  assert.throws(() => roomEventToSlack({ id: 'x' }, CTX), TypeError);
});

test('supportedEventTypes lists the mapped catalog', () => {
  const types = supportedEventTypes();
  assert.ok(types.includes('message.posted'));
  assert.ok(types.includes('work.claimed'));
  assert.ok(types.length >= 10);
});

// ---------- inbound-map ----------

test('app_mention strips the bot mention and becomes a room command', () => {
  const cmd = slackEventToRoom(
    { type: 'event_callback', event: { type: 'app_mention', user: 'U-ALICE', channel: 'C-ROOM', ts: '1.1', text: `<@${FAKE_BOT_USER}> status please` } },
    { botUserId: FAKE_BOT_USER, channel: 'C-ROOM' },
  );
  assert.ok(cmd);
  assert.equal(cmd.type, 'message.posted');
  assert.equal(cmd.data.body, 'status please');
  assert.equal(cmd.data.via, 'slack-adapter');
});

test('plain message becomes a room command', () => {
  const cmd = slackEventToRoom(
    { type: 'event_callback', event: { type: 'message', user: 'U-ALICE', text: 'hello room' } },
    { botUserId: FAKE_BOT_USER },
  );
  assert.ok(cmd);
  assert.equal(cmd.data.body, 'hello room');
});

test('echoes, bot messages and edits are suppressed', () => {
  const ctx = { botUserId: FAKE_BOT_USER };
  assert.equal(slackEventToRoom({ event: { type: 'message', user: FAKE_BOT_USER, text: 'mine' } }, ctx), null);
  assert.equal(slackEventToRoom({ event: { type: 'message', user: 'U-X', bot_id: 'B1', text: 'x' } }, ctx), null);
  assert.equal(slackEventToRoom({ event: { type: 'message', user: 'U-X', subtype: 'message_changed', text: 'x' } }, ctx), null);
  assert.equal(slackEventToRoom({ event: { type: 'app_mention', user: 'U-X', text: `<@${FAKE_BOT_USER}>` } }, ctx), null);
  assert.equal(slackEventToRoom({ event: { type: 'reaction_added', user: 'U-X' } }, ctx), null);
  assert.equal(slackEventToRoom(null, ctx), null);
});

test('verifySlackSignature accepts a correct signature and rejects bad ones', async () => {
  const { createHmac } = await import('node:crypto');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = '{"hello":"world"}';
  const sig = `v0=${createHmac('sha256', FAKE_SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  assert.equal(verifySlackSignature({ signingSecret: FAKE_SIGNING_SECRET, timestamp, rawBody, signature: sig }), true);
  assert.equal(verifySlackSignature({ signingSecret: FAKE_SIGNING_SECRET, timestamp, rawBody, signature: 'v0=deadbeef' }), false);
  assert.equal(verifySlackSignature({ signingSecret: FAKE_SIGNING_SECRET, timestamp: '1', rawBody, signature: sig }), false); // stale
  assert.equal(verifySlackSignature({ signingSecret: 'wrong', timestamp, rawBody, signature: sig }), false);
});

// ---------- bot ----------

test('bot dedupes room events by id and threads replies', async () => {
  const fake = makeFake();
  const sunk = [];
  const bot = new SlackBot({ fake, roomSink: (c) => sunk.push(c), channel: 'C-ROOM', directory: CTX.directory });
  const parent = { id: 'p1', sequence: 1, type: 'message.posted', actorId: 'alice', data: { authorId: 'alice', body: 'parent' } };
  const reply = { id: 'r1', sequence: 2, type: 'thread_reply', actorId: 'alice', data: { authorId: 'alice', body: 'child', replyToId: 'p1' } };
  await bot.handleRoomEvent(parent);
  await bot.handleRoomEvent(parent); // duplicate
  await bot.handleRoomEvent(reply);
  const msgs = fake.messages('C-ROOM');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].thread_ts, msgs[0].ts);
  const stats = bot.stats();
  assert.equal(stats.posted, 2);
  assert.equal(stats.skipped, 1);
});

test('bot forwards inbound mentions to the room sink', async () => {
  const fake = makeFake();
  const sunk = [];
  const bot = new SlackBot({ fake, roomSink: (c) => sunk.push(c), channel: 'C-ROOM' }).start();
  fake.emitSlackEvent({ type: 'event_callback', event: { type: 'app_mention', user: 'U-ALICE', text: `<@${FAKE_BOT_USER}> ping` } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sunk.length, 1);
  assert.equal(sunk[0].data.body, 'ping');
  bot.stop();
  assert.equal(bot.stats().inbound, 1);
});

test('bot records fallbacks in stats for unmapped types', async () => {
  const fake = makeFake();
  const bot = new SlackBot({ fake, roomSink: () => {}, channel: 'C-ROOM' });
  await bot.handleRoomEvent({ id: 'z1', sequence: 1, type: 'weird.future', actorId: 'a', data: {} });
  assert.equal(bot.stats().fallbacks, 1);
  assert.equal(fake.messages('C-ROOM').length, 1);
});

test('bot constructor validates its wiring', () => {
  assert.throws(() => new SlackBot({ roomSink: () => {}, channel: 'C' }), /fake/);
  assert.throws(() => new SlackBot({ fake: makeFake(), channel: 'C' }), /roomSink/);
  assert.throws(() => new SlackBot({ fake: makeFake(), roomSink: () => {} }), /channel/);
});
