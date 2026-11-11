import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {collectNeedsMe} from '../server/needs-me.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';

// #6033 held the cursor below items leased by another handler, but only for
// the page that suppressed them. A normalized room's native walk writes
// rooms[roomId] on its final page, so asks suppressed on earlier pages fell
// past the cursor: after the first handler crashed and its leases lapsed, a
// replay from the second handler's cursor never returned them.
function setup(t) {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  let clock = Date.now(); store.now = () => clock += 2100;
  const rooms = new AgentRooms(store), owner = store.identities.create('Owen'), bob = store.identities.create('Bob'), ada = store.identities.create('Ada');
  rooms.create(owner.secret, {roomId: 'attention', title: 'Attention', purpose: 'Lease recovery', kind: 'personal'});
  for (const [identity, name] of [[bob, 'Bob'], [ada, 'Ada']]) linkWithProof(store, owner.secret, 'attention', identity, {displayName: name, permissions: []});
  const post = (who, id, body) => store.command(who.secret, 'attention', {id, type: 'message.posted', data: {messageId: id, body}});
  return {store, bob, ada, post};
}
function walk(store, secret, since, claimSec) {
  const pages = [];
  for (let n = 0; n < 200; n++) {
    const page = collectNeedsMe(store, secret, {since, claimSec});
    pages.push(page);
    since = JSON.parse(JSON.stringify(page.cursor));
    if (page.complete) return {pages, cursor: since, ids: pages.flatMap(p => p.items.map(i => i.id))};
  }
  assert.fail('walk did not complete');
}

test('asks leased elsewhere on any page of a multi-page walk come back after the lease lapses', t => {
  const {store, bob, ada, post} = setup(t);
  const asks = Array.from({length: 12}, (_, i) => `ask-${i}`);
  for (const id of asks) post(bob, id, `@Ada ${id}`);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const start = {rooms: {attention: 0}, land: {}, landIds: {}};

  const first = walk(store, ada.secret, start, 45);
  assert.ok(first.pages.length > 2, `fixture spans several pages (${first.pages.length})`);
  assert.deepEqual(asks.filter(id => !first.ids.includes(id)), [], 'first handler leases every ask');

  const second = walk(store, ada.secret, start, 45);
  assert.deepEqual(second.ids.filter(id => asks.includes(id)), [], 'second handler sees none while leased');
  // The first handler crashes without acting; its leases lapse.
  now += 46_000;
  const replay = walk(store, ada.secret, second.cursor, 45);
  assert.deepEqual(asks.filter(id => !replay.ids.includes(id)), [], 'every ask returns from the held cursor');
});

test('a walk with nothing suppressed carries no hold and advances normally', t => {
  const {store, bob, ada, post} = setup(t);
  for (let i = 0; i < 12; i++) post(bob, `solo-${i}`, `@Ada solo-${i}`);
  const run = walk(store, ada.secret, {rooms: {attention: 0}, land: {}, landIds: {}}, 45);
  assert.ok(run.pages.every(page => page.cursor.held === undefined));
  const again = walk(store, ada.secret, run.cursor, 45);
  assert.deepEqual(again.ids.filter(id => id.startsWith('solo-')), [], 'delivered asks do not replay');
});

test('one leased page does not stall a second handler or hide its other asks', t => {
  const {store, bob, ada, post} = setup(t);
  for (let i = 0; i < 12; i++) post(bob, `ask-${i}`, `@Ada ask-${i}`);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const start = {rooms: {attention: 0}, land: {}, landIds: {}};
  // Handler A takes only the first page with asks, then goes off to work.
  let since = start, leased = [];
  for (let n = 0; n < 20 && !leased.length; n++) {
    const page = collectNeedsMe(store, ada.secret, {since, claimSec: 45});
    leased = page.items.map(item => item.id); since = JSON.parse(JSON.stringify(page.cursor));
  }
  assert.ok(leased.length > 0 && leased.length < 12);
  post(bob, 'late', '@Ada late');
  // Handler B finishes its walk while A's lease is live and gets everything else.
  const second = walk(store, ada.secret, start, 45);
  assert.ok(second.pages.length < 20, 'second handler completes without spinning');
  const expected = [...Array.from({length: 12}, (_, i) => `ask-${i}`).filter(id => !leased.includes(id)), 'late'];
  assert.deepEqual(expected.filter(id => !second.ids.includes(id)), []);
  assert.deepEqual(second.ids.filter(id => leased.includes(id)), [], 'leased asks stay with A');
  now += 46_000;
  const replay = walk(store, ada.secret, second.cursor, 45);
  assert.deepEqual(leased.filter(id => !replay.ids.includes(id)), [], 'A crashed: its asks come back to B');
});
