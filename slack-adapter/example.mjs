// example.mjs — runnable end-to-end demo of the Slack adapter prototype.
// Everything runs against FakeSlack: no network, no real workspace, no tokens.
//
// Usage: node slack-adapter/example.mjs
// Prints: the fake #room channel contents after replaying a small script of
// room events, then one inbound Slack mention becoming a room command.

import { FakeSlack, FAKE_TOKEN, FAKE_BOT_USER } from './fake-slack.mjs';
import { SlackBot } from './bot.mjs';

const fake = new FakeSlack({ token: FAKE_TOKEN })
  .addChannel({ id: 'C-ROOM', name: 'room' })
  .addUser({ id: 'U-ALICE', name: 'alice', real_name: 'Alice' })
  .addUser({ id: 'U-BOB', name: 'bob', real_name: 'Bob' });

const directory = new Map([
  ['alice', { slackId: 'U-ALICE', displayName: 'Alice' }],
  ['bob', { slackId: 'U-BOB', displayName: 'Bob' }],
]);

const roomCommands = [];
const bot = new SlackBot({
  fake,
  roomSink: (cmd) => roomCommands.push(cmd),
  channel: 'C-ROOM',
  directory,
}).start();

const roomEvents = [
  { id: 'ev-001', sequence: 1, type: 'message.posted', actorId: 'alice', at: '2026-10-09T08:00:00Z', data: { authorId: 'alice', body: 'Shipping the adapter prototype today. Review the SPEC when you can.' } },
  { id: 'ev-002', sequence: 2, type: 'thread_reply', actorId: 'bob', at: '2026-10-09T08:01:00Z', data: { authorId: 'bob', body: 'On it — will read after standup.', replyToId: 'ev-001' } },
  { id: 'ev-003', sequence: 3, type: 'work.claimed', actorId: 'bob', at: '2026-10-09T08:02:00Z', data: { taskId: 'RC-2026-10-09-031', ownerId: 'bob', files: ['slack-adapter/event-map.mjs'] } },
  { id: 'ev-004', sequence: 4, type: 'member.access_changed', actorId: 'alice', at: '2026-10-09T08:03:00Z', data: { memberId: 'carol', action: 'granted' } },
  { id: 'ev-005', sequence: 5, type: 'bond.proposed', actorId: 'alice', at: '2026-10-09T08:04:00Z', data: { amount: '10 $DASHA' } },
  { id: 'ev-006', sequence: 6, type: 'something.new_entirely', actorId: 'alice', at: '2026-10-09T08:05:00Z', data: {} },
  { id: 'ev-001', sequence: 1, type: 'message.posted', actorId: 'alice', at: '2026-10-09T08:00:00Z', data: { authorId: 'alice', body: 'DUPLICATE — must not post twice' } },
];

for (const event of roomEvents) {
  await bot.handleRoomEvent(event);
}

// Inbound: a human mentions the bot in Slack; it becomes a room command.
fake.emitSlackEvent({
  type: 'event_callback',
  event: { type: 'app_mention', user: 'U-ALICE', channel: 'C-ROOM', ts: '1728000001.000001', text: `<@${FAKE_BOT_USER}> what's the status of RC-2026-10-09-031?` },
});
// Wait a tick for the async inbound handler.
await new Promise((r) => setTimeout(r, 50));

console.log('=== fake #room channel ===');
for (const m of fake.messages('C-ROOM')) {
  const thread = m.thread_ts ? ` (thread ${m.thread_ts})` : '';
  console.log(`[${m.ts}]${thread} ${m.username}: ${m.text.slice(0, 100)}`);
}
console.log('\n=== room commands from inbound ===');
for (const c of roomCommands) {
  console.log(`${c.type}: ${c.data.body.slice(0, 80)} (via ${c.data.via})`);
}
console.log('\n=== bot stats ===');
console.log(JSON.stringify(bot.stats(), null, 2));
