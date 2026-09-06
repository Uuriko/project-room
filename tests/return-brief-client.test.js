import test from "node:test";
import assert from "node:assert/strict";
import { ReturnBrief } from "../src/return-brief.js";

const page = (items = [1, 2], { horizon = 4, cursor = 0, viewerId = "owner", roomId = "commons" } = {}) => ({
  viewerId, roomId,
  history: { cursor, evaluatedThrough: horizon, items: items.map(sequence => ({ sequence, event: { id: `e${sequence}` } })),
    hasMore: (items.at(-1) ?? cursor) < horizon,
    continuation: (items.at(-1) ?? cursor) < horizon ? { horizon, after: items.at(-1) ?? cursor, cursor } : null },
  current: { evaluatedThrough: horizon, needsAttention: [], workInvolvingMe: [] }
});
function fixture() {
  const pending = [], errors = [], acknowledgments = [];
  const client = {
    generation: 0, session: { roomId: "commons", member: { id: "owner" } },
    returnBrief(options) { return new Promise((resolve, reject) => pending.push({ options, resolve, reject })); },
    caughtUp(sequence) { acknowledgments.push(sequence); return Promise.resolve(); },
    refresh() { return Promise.resolve(); },
    endAccess() { this.generation++; this.session = null; }
  };
  const view = new ReturnBrief(client, { onError: e => errors.push(e) });
  return { client, view, pending, errors, acknowledgments };
}

test("obsolete brief successes and failures cannot affect a new session, room, or viewer", async () => {
  for (const change of [c => c.generation++, c => c.session.roomId = "other", c => c.session.member.id = "other"]) {
    for (const outcome of ["success", "failure"]) {
      const { view, client, pending, errors } = fixture();
      const old = view.refresh(); change(client);
      const current = view.refresh();
      pending[1].resolve(page([1], { horizon: 1, roomId: client.session.roomId, viewerId: client.session.member.id }));
      await current;
      const before = view.brief;
      if (outcome === "success") pending[0].resolve(page());
      else pending[0].reject(Object.assign(new Error("Old session ended"), { status: 401 }));
      await old;
      assert.equal(view.brief, before); assert.equal(view.busy, false); assert.deepEqual(errors, []);
      assert.ok(client.session);
    }
  }
});

test("refresh replaces an old continuation chain even at the same horizon", async () => {
  const { view, pending } = fixture();
  const first = view.refresh(); pending[0].resolve(page()); await first;
  const oldMore = view.more();
  const fresh = view.refresh(); pending[2].resolve(page()); await fresh;
  pending[1].resolve(page([3, 4])); await oldMore;
  assert.deepEqual(view.brief.history.items.map(i => i.sequence), [1, 2]);
  const more = view.more(); pending[3].resolve(page([3, 4])); await more;
  assert.deepEqual(view.brief.history.items.map(i => i.sequence), [1, 2, 3, 4]);
});

test("concurrent More requests share one fetch; a failed page can be retried once in order", async () => {
  const { view, pending, errors } = fixture();
  const first = view.refresh(); pending[0].resolve(page()); await first;
  const one = view.more(), two = view.more();
  assert.equal(one, two); assert.equal(pending.length, 2);
  pending[1].reject(new Error("offline")); await one;
  assert.equal(errors.length, 1); assert.equal(view.busy, false);
  assert.deepEqual(view.brief.history.items.map(i => i.sequence), [1, 2]);
  const retry = view.more(); pending[2].resolve(page([3, 4])); await retry;
  await view.more();
  assert.equal(pending.length, 3);
  assert.deepEqual(view.brief.history.items.map(i => i.sequence), [1, 2, 3, 4]);
});

test("a failed fresh refresh cannot resume the previous chain", async () => {
  const { view, pending } = fixture();
  const first = view.refresh(); pending[0].resolve(page()); await first;
  const refresh = view.refresh(); pending[1].reject(new Error("offline")); await refresh;
  assert.equal(view.brief, null); await view.more(); assert.equal(pending.length, 2);
});

test("a page for a different server-reported viewer clears the brief before rendering", async () => {
  const { view, client, pending } = fixture();
  const first = view.refresh(); pending[0].resolve(page([1], { viewerId: "other" })); await first;
  assert.equal(view.brief, null); assert.equal(client.session, null); assert.equal(view.busy, false);
});

test("reading never acknowledges; explicit acknowledgement uses frozen H and coalesces clicks", async () => {
  const { view, client, pending, acknowledgments } = fixture();
  const first = view.refresh(); pending[0].resolve(page([1, 2], { horizon: 2 })); await first;
  assert.deepEqual(acknowledgments, []);
  let saved; client.caughtUp = sequence => { acknowledgments.push(sequence); return new Promise(resolve => saved = resolve); };
  const ack = view.acknowledge(); await view.acknowledge();
  assert.deepEqual(acknowledgments, [2]); saved();
  // The response to the post-ack refresh contains the new event H+1.
  await new Promise(resolve => setImmediate(resolve));
  pending[1].resolve(page([3], { horizon: 3, cursor: 2 })); await ack;
  assert.deepEqual(view.brief.history.items.map(i => i.sequence), [3]);
});

test("old acknowledgement failures cannot clear or report into a new view", async () => {
  const { view, client, pending, errors } = fixture();
  const first = view.refresh(); pending[0].resolve(page([1], { horizon: 1 })); await first;
  let fail; client.caughtUp = () => new Promise((resolve, reject) => fail = reject);
  const ack = view.acknowledge(); client.generation++;
  const fresh = view.refresh(); pending[1].resolve(page([1], { horizon: 1 })); await fresh;
  fail(Object.assign(new Error("expired"), { status: 401 })); await ack;
  assert.equal(view.brief.history.items.length, 1); assert.deepEqual(errors, []); assert.equal(view.busy, false);
});

test("a moved marker restarts once; an out-of-order page never appends", async () => {
  const { view, pending, errors } = fixture();
  const first = view.refresh(); pending[0].resolve(page()); await first;
  const more = view.more(); pending[1].reject(Object.assign(new Error("marker moved"), { code: "cursor_changed" }));
  await new Promise(resolve => setImmediate(resolve));
  pending[2].resolve(page([2, 3], { cursor: 1 })); await more;
  assert.equal(view.brief.history.cursor, 1); assert.deepEqual(errors, []);
  const invalid = view.more(); pending[3].resolve(page([3, 4], { cursor: 1 })); await invalid;
  assert.equal(errors.length, 1); assert.deepEqual(view.brief.history.items.map(i => i.sequence), [2, 3]);
});
