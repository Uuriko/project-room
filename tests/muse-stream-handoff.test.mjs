import assert from "node:assert/strict";
import test from "node:test";
import { holdMuseHandoff, museHandoffPolicy, museSeenAction, recoverMuseHandoff, runMuseHandoff } from "../scripts/muse-stream-handoff.mjs";

const connection = { origin: "https://room.example.org", roomId: "build", memberId: "muse" };
const policy = museHandoffPolicy({ ...connection, version: 1, requesters: ["codex"], workItems: ["ready"],
  requests: [], bootstrapAfter: 10, windowSeconds: 10 }, connection);
const request = (id, patch = {}) => ({ id, status: "open", requesterId: "codex", recipientId: "muse",
  workItemId: "ready", openingEventId: "open-" + id, revision: 0, ...patch });
const context = (row, sequence) => ({ roomId: "build", viewerId: "muse", roomCreatedEventId: "room-birth",
  request: row, page: { items: [{ kind: "opened", eventId: row.openingEventId, sequence, message: { body: "private QA details" } }] } });

test("one handoff skips unrelated, acknowledged, closed and old requests and preserves the next ready request", async () => {
  const old = request("old"), closed = request("closed"), seen = request("seen");
  const first = request("first"), second = request("second"), reads = [];
  let scans = 0;
  const client = {
    replyRequests({ cursor }) {
      if (cursor) return { evaluatedThrough: 20, requests: [first], page: { hasMore: false } };
      if (++scans === 1) return { evaluatedThrough: 14, requests: [old, closed, seen,
        request("self", { requesterId: "muse" }), request("other-work", { workItemId: "other" })] };
      return { evaluatedThrough: 20, requests: [second], page: { hasMore: true, nextCursor: "continued" } };
    },
    replyContext(id) {
      reads.push(id);
      return {
        old: context(old, 9), closed: context({ ...closed, status: "answered" }, 12),
        seen: context({ ...seen, acknowledgedAt: "2026-11-18T21:00:00Z" }, 13),
        first: context(first, 15), second: context(second, 17)
      }[id];
    },
    waitForChange(after) {
      assert.equal(after, 14);
      return { changed: true, sequence: 16 };
    }
  };
  let checkpoint = { after: 10, inFlight: null };
  const signal = new AbortController().signal, save = value => { checkpoint = value; };
  const result = await holdMuseHandoff({ client, policy, checkpoint, save, signal });
  assert.equal(result.requestMessageId, "first");
  assert.equal(result.after, 15);
  assert.equal(checkpoint.inFlight.requestMessageId, "first");
  assert.deepEqual(reads, ["old", "closed", "seen", "second", "first"]);
  assert.doesNotMatch(JSON.stringify(result), /private QA/);
});

test("reconnect preserves an unseen pointer and assigns newer work after it is acknowledged", async () => {
  const first = request("first"), second = request("second"), writes = [];
  let done = false;
  const client = {
    replyContext(id) { return id === "first" ? context({ ...first, ...(done ? { progressState: "acknowledged" } : {}) }, 15) : context(second, 17); },
    replyRequests() { return { evaluatedThrough: 17, requests: [second] }; }
  };
  let checkpoint = { after: 15, inFlight: {
    requestMessageId: "first", requesterId: "codex", recipientId: "muse", roomCreatedEventId: "room-birth",
    openingEventId: "open-first", openingSequence: 15, requestRevision: 0
  } };
  const run = () => holdMuseHandoff({ client, policy, checkpoint, signal: new AbortController().signal, save(value) { writes.push(value); checkpoint = value; } });
  assert.equal((await run()).replay, true);
  assert.equal(writes.length, 0);
  done = true;
  const result = await run();
  assert.equal(result.requestMessageId, "second");
  assert.equal(result.replay, false);
  assert.equal(writes[0].inFlight, null);
});

test("empty wait never starts work and clock expiry respects the stop signal", async () => {
  const controller = new AbortController();
  let waited = 0;
  const client = {
    replyRequests() { return { evaluatedThrough: 11, requests: [] }; },
    waitForChange(after) { assert.equal(after, 11); if (++waited === 2) controller.abort(); return { changed: false }; }
  };
  await assert.rejects(holdMuseHandoff({ client, policy, checkpoint: { after: 10, inFlight: null },
    signal: controller.signal, save() {} }), { name: "AbortError" });
  assert.equal(waited, 2);
});

test("an existing host listener can scan and return without opening a second event stream", async () => {
  const client = {
    replyRequests() { return { evaluatedThrough: 12, requests: [] }; },
    waitForChange() { assert.fail("one-shot selection must open no stream"); }
  };
  let saved;
  const result = await holdMuseHandoff({ client, policy, checkpoint: { after: 10, inFlight: null },
    signal: new AbortController().signal, wait: false, save(state) { saved = state; } });
  assert.deepEqual(result, { status: "no_work", after: 12 });
  assert.deepEqual(saved, { after: 12, inFlight: null });
});

test("a stream pointer selects the exact authenticated request without listing again", async () => {
  const ready = request("direct");
  let lists = 0, saved;
  const client = {
    replyRequests() { assert.equal(++lists, 1); return { evaluatedThrough: 14, requests: [] }; },
    waitForChange(after, options) {
      assert.equal(after, 14); assert.equal(options.requestHints, true);
      return { changed: true, sequence: 15, requestHint: { ...ready, observedAt: "2026-11-18T21:00:00Z" } };
    },
    replyContextForHint(id) { assert.equal(id, ready.id); return context(ready, 15); }
  };
  const result = await holdMuseHandoff({ client, policy, checkpoint: { after: 10, inFlight: null },
    signal: new AbortController().signal, save(state) { saved = state; } });
  assert.equal(result.source, "stream_pointer");
  assert.equal(result.requestMessageId, ready.id);
  assert.equal(saved.inFlight.openingSequence, 15);
  assert.doesNotMatch(JSON.stringify(result), /private QA/);
});

test("standalone asks require explicit opt-in and still honor requester, recipient and linked-work scopes", async () => {
  const direct = request("standalone", { workItemId: null });
  const rules = { ...policy, workItems: [], requests: [] };
  assert.throws(() => museHandoffPolicy(rules, connection), /invalid_muse_handoff_policy/);
  assert.throws(() => museHandoffPolicy({ ...rules, allowStandaloneRequests: "true" }, connection), /invalid_muse_handoff_policy/);
  const optedIn = museHandoffPolicy({ ...rules, allowStandaloneRequests: true }, connection);
  const reads = [];
  const client = {
    replyRequests() {
      return { evaluatedThrough: 21, requests: [
        request("wrong-sender", { requesterId: "unapproved", workItemId: null }),
        request("wrong-recipient", { recipientId: "other", workItemId: null }),
        request("out-of-scope-work", { workItemId: "private" }),
        request("missing-work-field", { workItemId: undefined }),
        direct,
      ] };
    },
    replyContext(id) { reads.push(id); return context(direct, 21); },
  };
  const run = selected => holdMuseHandoff({ client, policy: selected, checkpoint: { after: 10, inFlight: null },
    signal: new AbortController().signal, save() {}, wait: false });
  assert.equal((await run(policy)).status, "no_work");
  assert.deepEqual(reads, []);
  assert.equal((await run(optedIn)).requestMessageId, direct.id);
  assert.deepEqual(reads, [direct.id]);
});

test("an opted-in standalone stream wake reads only its exact request and saves before handoff", async () => {
  const direct = request("direct-standalone", { workItemId: null });
  const optedIn = museHandoffPolicy({ ...policy, allowStandaloneRequests: true }, connection);
  let lists = 0, exactReads = 0, saved;
  const client = {
    replyRequests() { lists++; return { evaluatedThrough: 14, requests: [] }; },
    waitForChange() { return { changed: true, sequence: 15, requestHint: direct }; },
    replyContextForHint(id) { exactReads++; assert.equal(id, direct.id); return context(direct, 15); },
  };
  const result = await holdMuseHandoff({ client, policy: optedIn, checkpoint: { after: 10, inFlight: null },
    signal: new AbortController().signal, save(state) { saved = state; } });
  assert.equal(result.source, "stream_pointer");
  assert.equal(result.requestMessageId, direct.id);
  assert.equal(saved.inFlight.openingEventId, direct.openingEventId);
  assert.equal(lists, 1);
  assert.equal(exactReads, 1);
  assert.doesNotMatch(JSON.stringify(result), /private QA/);
});

test("a stay-armed process rolls a quiet window into one handoff", async () => {
  const stop = new AbortController(), windows = [];
  let rounds = 0;
  const result = await runMuseHandoff({ mode: "--stay-armed", windowMs: 1000, stop: stop.signal,
    makeWindow() { const next = new AbortController(); windows.push(next); return next.signal; },
    run(signal) {
      if (++rounds === 1) {
        windows[0].abort();
        signal.throwIfAborted();
      }
      return { status: "handoff", requestMessageId: "real-work" };
    } });
  assert.equal(rounds, 2);
  assert.equal(result.quietWindows, 1);
  assert.ok(result.lastQuietAt);
  assert.equal(result.requestMessageId, "real-work");
});

test("a quiet rollover resumes a checked stream without an inbox read", async () => {
  const windows = [], rollover = [], ready = request("after-rollover");
  let lists = 0, hops = 0, saved = { after: 10, inFlight: null };
  const client = {
    replyRequests() { assert.equal(++lists, 1); return { evaluatedThrough: 14, requests: [] }; },
    waitForChange(after, { signal }) {
      assert.equal(after, 14);
      if (++hops === 1) { windows[0].abort(); signal.throwIfAborted(); }
      return { changed: true, sequence: 15, requestHint: ready };
    },
    replyContextForHint() { return context(ready, 15); }
  };
  const result = await runMuseHandoff({ mode: "--stay-armed", windowMs: 1000, stop: new AbortController().signal,
    makeWindow() { const next = new AbortController(); windows.push(next); return next.signal; },
    onRollover(facts) { rollover.push(facts); },
    run(signal, progress) { return holdMuseHandoff({ client, policy, checkpoint: saved, save(value) { saved = value; }, signal, ...progress }); }
  });
  assert.equal(rollover.length, 1);
  assert.equal(result.quietWindows, 1);
  assert.equal(result.source, "stream_pointer");
  assert.equal(lists, 1);
});

test("interrupted delivery waits once, then rechecks and replays only the exact unseen opening", async () => {
  const pending = { requestMessageId: "ready", openingEventId: "open-ready", openingSequence: 15,
    roomCreatedEventId: "room-birth", offeredAt: "2026-11-18T21:00:00Z" };
  const seen = { ...pending, requestMessageId: "already-seen", openingEventId: "open-already-seen", openingSequence: 14 };
  const replaced = { ...pending, openingSequence: 13, openingEventId: "open-replaced" };
  let current;
  const reads = [], waits = [], records = [];
  const offers = (async function* () {
    yield null;
    current = replaced;
    yield replaced;
    current = seen;
    yield seen;
    current = pending;
    yield pending;
  })();
  const result = await recoverMuseHandoff({ policy, offers, signal: new AbortController().signal,
    currentOffer: () => current, now: () => Date.parse(pending.offeredAt) + 1000,
    delay: async ms => { waits.push(ms); if (current === replaced) current = null; },
    client: { replyContextForHint(id) {
      reads.push(id);
      if (id === seen.requestMessageId) return context(request(id, { progressState: "acknowledged" }), 14);
      return context(request(id, { revision: 2 }), 15);
    } },
    record: item => records.push(item.openingEventId)
  });
  assert.deepEqual(waits, [5500, 5500, 5500]);
  assert.deepEqual(reads, ["already-seen", "ready"]);
  assert.deepEqual(records, ["open-ready"]);
  assert.equal(result.replay, true);
  assert.equal(result.source, "interrupted_delivery");
  assert.equal(result.requestMessageId, "ready");
  assert.equal(result.openingSequence, 15);
  assert.equal(result.requestRevision, 2);
});

test("interrupted delivery never reopens settled work or replays a different room", async () => {
  const offer = { requestMessageId: "ready", openingEventId: "open-ready", openingSequence: 15,
    roomCreatedEventId: "room-birth", offeredAt: "2026-11-18T21:00:00Z" };
  const args = { policy, signal: new AbortController().signal, offers: [offer], currentOffer: () => offer,
    delay: async () => {}, record: () => assert.fail("must not publish a replay") };
  const answered = context(request("ready", { status: "answered" }), 15);
  assert.equal(await recoverMuseHandoff({ ...args, client: { replyContextForHint: () => answered } }), undefined);
  const other = { ...context(request("ready"), 15), roomCreatedEventId: "another-birth" };
  await assert.rejects(recoverMuseHandoff({ ...args, client: { replyContextForHint: () => other } }),
    /muse_handoff_identity_changed/);
});

test("a standalone request survives a new receiver invocation with the original acknowledgment operation", async () => {
  const standalone = request("open-after-restart", { workItemId: null });
  const optedIn = museHandoffPolicy({ ...policy, allowStandaloneRequests: true }, connection);
  let current = standalone, saved;
  const firstClient = {
    replyRequests: () => ({ evaluatedThrough: 15, requests: [standalone] }),
    replyContext: () => context(standalone, 15),
  };
  const primary = await holdMuseHandoff({ client: firstClient, policy: optedIn, checkpoint: { after: 10, inFlight: null },
    signal: new AbortController().signal, save: state => { saved = state; }, wait: false });
  const offer = { ...saved.inFlight, offeredAt: "2026-11-18T21:00:00Z" };
  const replay = () => recoverMuseHandoff({ policy: optedIn, offers: [offer], currentOffer: () => offer,
    client: { replyContextForHint: () => context(current, 15) },
    signal: new AbortController().signal, record() {}, delay: async () => {} });
  current = { ...standalone, revision: 2 };
  const recovered = await replay();
  const originalAction = museSeenAction(primary, connection.roomId);
  const replayAction = museSeenAction(recovered, connection.roomId);
  assert.equal(recovered.openingEventId, primary.openingEventId);
  assert.equal(replayAction.arguments.requestId, originalAction.arguments.requestId);
  assert.equal(replayAction.arguments.expectedRequestRevision, 2);
  current = { ...current, progressState: "acknowledged" };
  assert.equal(await replay(), undefined);
});

test("receiver acknowledges only after saving the exact pointer and recovers the same write", async () => {
  const ask = request("signed-off");
  let checkpoint = {after: 10, inFlight: null};
  let progress = {};
  const calls = [];
  const client = {
    replyRequests: () => ({evaluatedThrough: 10, requests: [ask]}),
    replyContext: () => context({...ask, ...progress}, 11),
    replyAction(name, args) {
      assert.equal(checkpoint.inFlight.requestMessageId, ask.id);
      assert.equal(name, "room_progress_request");
      assert.equal(args.progress, "acknowledged");
      calls.push(args);
      progress = {acknowledgedAt: "2026-11-19T00:00:00Z", progressState: "acknowledged", progressNote: args.note};
      if (calls.length === 1) throw new TypeError("Response interrupted");
      return {status: "recorded", sequence: 12, duplicate: true};
    }
  };
  const run = () => holdMuseHandoff({client, policy, checkpoint, receiverAck: true,
    signal: new AbortController().signal, save(state) { checkpoint = state; }});
  await assert.rejects(run(), /interrupted/);
  const recovered = await run();
  assert.equal(recovered.receiverAcknowledgment.sequence, 12);
  assert.equal(recovered.receiverAcknowledgment.duplicate, true);
  assert.deepEqual(calls[0], calls[1]);
});
