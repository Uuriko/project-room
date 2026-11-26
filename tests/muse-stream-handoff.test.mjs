import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { RoomClientError } from "../client/room-agent.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkMuseRoute, holdMuseHandoff, museHandoffPolicy, museSeenAction, recoverMuseHandoff, runMuseHandoff } from "../scripts/muse-stream-handoff.mjs";

const connection = { origin: "https://room.example.org", roomId: "build", memberId: "muse" };
const policy = museHandoffPolicy({ ...connection, version: 1, requesters: ["codex"], workItems: ["ready"],
  requests: [], bootstrapAfter: 10, windowSeconds: 10 }, connection);
const request = (id, patch = {}) => ({ id, status: "open", requesterId: "codex", recipientId: "muse",
  workItemId: "ready", openingEventId: "open-" + id, revision: 0, ...patch });
const context = (row, sequence) => ({ roomId: "build", viewerId: "muse", roomCreatedEventId: "room-birth",
  request: row, page: { items: [{ kind: "opened", eventId: row.openingEventId, sequence, message: { body: "private QA details" } }] } });

async function checkSuccessorAfterSettlement(outcome) {
  const first = request("first"), successor = request("successor");
  const checkpoint = { after: 11, inFlight: { requestMessageId: first.id, openingEventId: first.openingEventId,
    roomCreatedEventId: "room-birth", openingSequence: 11 } };
  const saves = [], receipts = [];
  let finished = false, streamReads = 0;
  const result = await holdMuseHandoff({ policy, checkpoint, receiverAck: true, advertiseScope: true,
    afterSettlement: first.id, signal: AbortSignal.timeout(3000), save: value => saves.push(value), client: {
      async replyContext(id) {
        if (id === first.id) return { ...context({ ...first, status: finished ? outcome : "open" }, 11),
          evaluatedThrough: finished ? 19 : 12 };
        assert.equal(finished, true);
        return context({ ...successor, contextEventId: "successor-basis" }, 15);
      },
      async waitForChange(after, options) {
        assert.equal(after, streamReads++ === 0 ? 12 : 15);
        assert.equal(options.waitingForWork, undefined);
        assert.deepEqual(saves, []);
        if (after === 12) return { changed: true, sequence: 15 };
        finished = true;
        return { changed: true, sequence: 19 };
      },
      async replyRequests() {
        assert.equal(finished, true);
        return { requests: [successor], evaluatedThrough: 19 };
      },
      async command(command) {
        receipts.push(command.data.requestMessageId);
        return { event: { id: "seen-successor" }, sequence: 20 };
      },
    } });
  assert.deepEqual(saves.map(value => value.after), [11, 15]);
  assert.equal(streamReads, 2);
  assert.deepEqual(receipts, [successor.id]);
  assert.equal(result.requestMessageId, successor.id);
  assert.equal(result.replay, false);
}

for (const outcome of ["answered", "declined", "cancelled"]) {
  test(`a prearmed successor retains work opened before the previous request is ${outcome}`,
    () => checkSuccessorAfterSettlement(outcome));
}

test("prearming refuses a different request before opening a stream", async () => {
  await assert.rejects(holdMuseHandoff({ policy, client: {}, checkpoint: { after: 11,
    inFlight: { requestMessageId: "first" } }, signal: AbortSignal.timeout(3000), afterSettlement: "other" }),
  /muse_settlement_checkpoint_mismatch/);
});

test("a prearmed receiver preserves the unresolved offer through rollover and stop", { timeout: 8000 }, async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "muse-prearmed-offer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 });
  const first = request("first", { progressState: "acknowledged", contextEventId: "first-basis",
    progressNote: "Receiving runtime read and verified this exact request; model acceptance is separate." });
  const pending = { requestMessageId: first.id, requesterId: first.requesterId, recipientId: first.recipientId,
    roomCreatedEventId: "room-birth", openingEventId: first.openingEventId, openingSequence: 11, requestRevision: 0 };
  const offer = { ...pending, status: "handoff", pid: 1, offeredAt: new Date(0).toISOString(),
    receiverAcknowledgment: { sequence: 12 } };
  put("handoff.json", { ...policy, windowSeconds: 1 });
  put("stream-checkpoint.json", { version: 1,
    binding: [policy.origin, policy.roomId, policy.memberId, policy.requesters, policy.workItems, policy.requests, policy.bootstrapAfter],
    after: 11, inFlight: pending });
  put("receiver-status.json", offer);
  const preload = join(directory, "stub-room.mjs"), exactTrace = join(directory, "exact-reads.log");
  writeFileSync(preload, `
    import { appendFileSync } from "node:fs";
    import { RoomAgentClient, RoomClientError } from ${JSON.stringify(new URL("../client/room-agent.mjs", import.meta.url).href)};
    import { setTimeout } from "node:timers/promises";
    const read = async () => (${JSON.stringify({ ...context(first, 11), evaluatedThrough: 12 })});
    RoomAgentClient.prototype.replyContext = read;
    RoomAgentClient.prototype.replyContextForHint = async id => {
      appendFileSync(${JSON.stringify(exactTrace)}, id + "\\n");
      if (process.env.ROOM_FIXTURE_DENY_EXACT === "1")
        throw new RoomClientError(404, "reply_request_not_found", "Request not found in this Room");
      return read();
    };
    RoomAgentClient.prototype.command = async () => { throw Error("Unexpected new acknowledgment or work command"); };
    RoomAgentClient.prototype.waitForChange = async (after, { signal }) => setTimeout(60000, null, { signal });
  `);
  const args = ["--import", pathToFileURL(preload).href,
    fileURLToPath(new URL("../scripts/muse-stream-handoff.mjs", import.meta.url)), join(directory, "handoff.json"), "-"];
  const connectionInput = JSON.stringify({ ...connection, version: 1, token: "T".repeat(43) });
  const child = spawn(process.execPath, [...args, "--stay-armed", "--receiver-ack", "--after-settlement=first"]);
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  child.stdin.end(connectionInput);
  const status = () => JSON.parse(readFileSync(join(directory, "receiver-status.json")));
  const deadline = Date.now() + 5000;
  while (!status().prearmedReceiver && status().status === "handoff" && child.exitCode === null && Date.now() < deadline) await pause(30);
  const { prearmedReceiver, ...rolledOffer } = status();
  assert.deepEqual(rolledOffer, offer);
  assert.equal(prearmedReceiver?.status, "rolled_over", stderr || "prearmed receiver status was not recorded");
  assert.equal(prearmedReceiver.pid, child.pid);
  child.kill();
  assert.deepEqual(await exited, [0, null]);
  const { prearmedReceiver: stopped, ...stoppedOffer } = status();
  assert.deepEqual(stoppedOffer, offer);
  assert.equal(stopped.status, "stopped");
  assert.equal(JSON.parse(readFileSync(join(directory, "stream-checkpoint.json"))).inFlight.openingEventId, pending.openingEventId);
  const checkpointBeforeRecovery = readFileSync(join(directory, "stream-checkpoint.json"));
  const unreadable = spawnSync(process.execPath, [...args, "--recover"], {
    encoding: "utf8", input: connectionInput, timeout: 3000,
    env: { ...process.env, ROOM_FIXTURE_DENY_EXACT: "1" },
  });
  assert.equal(unreadable.status, 1, unreadable.stderr);
  assert.equal(unreadable.stdout, "");
  assert.equal(unreadable.stderr.trim(), "offer_unreadable");
  assert.deepEqual(readFileSync(join(directory, "stream-checkpoint.json")), checkpointBeforeRecovery);
  assert.deepEqual(status(), { ...stoppedOffer, prearmedReceiver: stopped });
  assert.ok(!readdirSync(directory).includes("recovery-receipt.json"));
  const recovery = spawnSync(process.execPath, [...args, "--recover"], {
    encoding: "utf8", input: connectionInput, timeout: 3000,
  });
  assert.equal(recovery.status, 0, recovery.stderr);
  const replay = JSON.parse(recovery.stdout);
  assert.equal(replay.source, "interrupted_delivery");
  assert.equal(replay.openingEventId, pending.openingEventId);
  assert.deepEqual(replay.receiverAcknowledgment, offer.receiverAcknowledgment);
  assert.equal(replay.seenAction, undefined);
  assert.equal(readFileSync(exactTrace, "utf8"), "first\nfirst\nfirst\n");
  const receiptPath = join(directory, "recovery-receipt.json");
  const receipt = readFileSync(receiptPath);
  assert.equal(JSON.parse(receipt).openingEventId, pending.openingEventId);

  const repeat = spawn(process.execPath, [...args, "--recover"]);
  const repeatExited = once(repeat, "exit");
  let repeatedOutput = "", repeatedError = "";
  repeat.stdout.setEncoding("utf8").on("data", chunk => { repeatedOutput += chunk; });
  repeat.stderr.setEncoding("utf8").on("data", chunk => { repeatedError += chunk; });
  t.after(async () => {
    if (repeat.exitCode === null && repeat.signalCode === null) repeat.kill();
    await repeatExited;
  });
  repeat.stdin.end(connectionInput);
  const armedPid = () => JSON.parse(readFileSync(join(directory, "recovery-status.json"))).pid;
  const repeatDeadline = Date.now() + 3000;
  while (armedPid() !== repeat.pid && repeat.exitCode === null && Date.now() < repeatDeadline) await pause(25);
  assert.equal(armedPid(), repeat.pid);
  repeat.kill();
  assert.deepEqual(await repeatExited, [0, null]);
  assert.equal(repeatedOutput, "");
  assert.equal(repeatedError, "");
  assert.equal(readFileSync(exactTrace, "utf8"), "first\nfirst\nfirst\n");
  assert.deepEqual(readFileSync(receiptPath), receipt);
  assert.deepEqual(readFileSync(join(directory, "stream-checkpoint.json")), checkpointBeforeRecovery);
});

for (const interruption of ["before_ack", "after_ack"]) {
  test(`the same prearmed command resumes a saved successor after an exit ${interruption}`, t => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "muse-prearmed-restart-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const put = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 });
    const read = name => JSON.parse(readFileSync(join(directory, name)));
    const first = request("first", { status: "answered", contextEventId: "first-basis" });
    const next = request("next", { contextEventId: "next-basis" });
    const pending = { requestMessageId: first.id, requesterId: first.requesterId, recipientId: first.recipientId,
      roomCreatedEventId: "room-birth", openingEventId: first.openingEventId, openingSequence: 11, requestRevision: 0 };
    put("handoff.json", { ...policy, windowSeconds: 1 });
    put("stream-checkpoint.json", { version: 1,
      binding: [policy.origin, policy.roomId, policy.memberId, policy.requesters, policy.workItems, policy.requests, policy.bootstrapAfter],
      after: 11, inFlight: pending });
    const previousOffer = { ...pending, status: "handoff", offeredAt: new Date(0).toISOString() };
    put("receiver-status.json", previousOffer);
    const preload = join(directory, "stub-room.mjs");
    writeFileSync(preload, `
      import { RoomAgentClient } from ${JSON.stringify(new URL("../client/room-agent.mjs", import.meta.url).href)};
      import assert from "node:assert/strict";
      import { setTimeout } from "node:timers/promises";
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      const ackFile = fileURLToPath(new URL("fixture-ack.json", import.meta.url));
      const phase = process.env.MUSE_RESTART_FIXTURE_PHASE;
      const first = ${JSON.stringify({ ...context(first, 11), evaluatedThrough: 15 })};
      const next = ${JSON.stringify(context(next, 15))};
      let nextReads = 0;
      RoomAgentClient.prototype.replyContext = async (id, { signal }) => {
        if (id === first.request.id) {
          if (phase === "changed_birth") first.roomCreatedEventId = "replacement-room";
          if (phase === "changed_opening") first.page.items[0].sequence = 12;
          return first;
        }
        assert.equal(id, next.request.id);
        if (nextReads++ === 0) {
          if (phase === "retry_published") throw Object.assign(Error("temporarily unavailable"), { status: 503 });
          if (phase === "rollover_published") await setTimeout(60000, null, { signal });
        }
        if (existsSync(ackFile)) {
          const ack = JSON.parse(readFileSync(ackFile));
          next.request.contextEventId = "acknowledged-basis";
          next.request.progressState = "acknowledged";
          next.request.progressNote = ack.data.note;
        }
        return next;
      };
      RoomAgentClient.prototype.replyRequests = async () => ({ requests: [next.request], evaluatedThrough: 15 });
      RoomAgentClient.prototype.command = async command => {
        assert.equal(command.id, "muse-seen-open-next");
        assert.equal(command.data.ifUnacknowledgedContextEventId, "next-basis");
        if (phase === "before_ack") process.exit(73);
        const duplicate = existsSync(ackFile);
        if (duplicate) assert.deepEqual(command, JSON.parse(readFileSync(ackFile)));
        else writeFileSync(ackFile, JSON.stringify(command), { flag: "wx", mode: 0o600 });
        if (phase === "after_ack") process.exit(73);
        return { event: { id: "next-ack" }, sequence: 17, duplicate };
      };
    `);
    const args = ["--import", pathToFileURL(preload).href,
      fileURLToPath(new URL("../scripts/muse-stream-handoff.mjs", import.meta.url)),
      join(directory, "handoff.json"), "-", "--stay-armed", "--receiver-ack", "--after-settlement=first"];
    const run = phase => spawnSync(process.execPath, args, {
      encoding: "utf8", input: JSON.stringify({ ...connection, version: 1, token: "T".repeat(43) }),
      timeout: 5000, env: { ...process.env, MUSE_RESTART_FIXTURE_PHASE: phase },
    });

    const interrupted = run(interruption);
    assert.equal(interrupted.status, 73, interrupted.stderr);
    assert.equal(interrupted.stdout, "");
    assert.deepEqual(read("receiver-status.json"), previousOffer);
    assert.equal(read("stream-checkpoint.json").inFlight.requestMessageId, next.id);
    const saved = read("stream-checkpoint.json");
    for (const altered of ["changed_birth", "changed_opening"]) {
      const refused = run(altered);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /muse_handoff_identity_changed/);
      assert.deepEqual(read("stream-checkpoint.json"), saved);
      assert.deepEqual(read("receiver-status.json"), previousOffer);
    }
    const resumed = run("resume");
    assert.equal(resumed.status, 0, resumed.stderr);
    const handoff = JSON.parse(resumed.stdout);
    assert.equal(handoff.requestMessageId, next.id);
    assert.equal(handoff.replay, true);
    assert.equal(handoff.receiverAcknowledgment.sequence, 17);
    assert.equal(handoff.receiverAcknowledgment.duplicate, interruption === "after_ack");
    assert.equal(read("receiver-status.json").openingEventId, next.openingEventId);
    assert.equal(read("fixture-ack.json").id, "muse-seen-open-next");
    const publishedOffer = read("receiver-status.json");
    for (const phase of ["resume", "retry_published", "rollover_published"]) {
      const published = run(phase);
      assert.equal(published.status, 1, `a published offer must not be reissued during ${phase}`);
      assert.match(published.stderr, /muse_successor_offer_already_published/);
      assert.equal(published.stdout, "");
      assert.deepEqual(read("receiver-status.json"), publishedOffer);
    }
  });
}

test("route check distinguishes requester, work and exact request scope without exposing configuration", t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "muse-route-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, "handoff.json");
  const exact = { ...policy, requests: ["approved"] };
  writeFileSync(config, JSON.stringify(exact), { mode: 0o600 });
  const script = fileURLToPath(new URL("../scripts/muse-stream-handoff.mjs", import.meta.url));
  const check = (...args) => {
    const result = spawnSync(process.execPath, [script, config, "-", "--check-route", ...args], {
      encoding: "utf8", input: JSON.stringify({ ...connection, version: 1, token: "T".repeat(43) }), timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(check("grok", "ready"), { status: "requester_outside_scope", liveness: "unknown" });
  assert.deepEqual(check("codex", "unrelated"), { status: "work_outside_scope", liveness: "unknown" });
  assert.deepEqual(check("codex", "ready"), { status: "matches_scope", liveness: "unknown" });
  assert.deepEqual(check("codex", "-", "approved"), { status: "matches_scope", liveness: "unknown" });
  assert.equal(checkMuseRoute({ ...policy, allowStandaloneRequests: true }, { requesterId: "codex", workItemId: null }), "matches_scope");
  assert.deepEqual(readdirSync(directory), ["handoff.json"]);
});

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

test("interrupted delivery preserves the receiver’s ACK and still offers the work once", async () => {
  const selected = request("ready", { contextEventId: "ctx-ready" });
  let current = selected, checkpoint = { after: 10, inFlight: null }, writes = 0;
  const signal = new AbortController().signal;
  const client = {
    replyRequests: () => ({ evaluatedThrough: 15, requests: [selected] }),
    replyContext: () => context(current, 15),
    replyContextForHint: () => context(current, 15),
    command(command) {
      writes++;
      current = { ...current, progressState: "acknowledged", acknowledgedAt: "2026-11-20T19:48:00Z", progressNote: command.data.note };
      return { event: { id: "first-ack" }, sequence: 16, duplicate: false };
    }
  };
  const primary = await holdMuseHandoff({ client, policy, checkpoint, signal, receiverAck: true,
    save(value) { checkpoint = value; }, wait: false });
  let pending = { ...checkpoint.inFlight, offeredAt: "2026-11-20T19:48:01Z", receiverAcknowledgment: primary.receiverAcknowledgment };
  const offers = [pending], records = [];
  const recover = () => recoverMuseHandoff({ client, policy, signal, offers, currentOffer: () => pending,
    record(exact) { records.push(exact.openingEventId); pending = null; }, delay: async () => {} });
  const replay = await recover();
  assert.equal(replay.source, "interrupted_delivery");
  assert.equal(replay.requestMessageId, selected.id);
  assert.deepEqual(replay.receiverAcknowledgment, primary.receiverAcknowledgment);
  assert.deepEqual(records, [selected.openingEventId]);
  assert.equal(writes, 1);
  assert.equal(await recover(), undefined);
});

for (const outcome of ["readable", "missing", "replaced", "aborted", "replaced_during_retry", "aborted_during_retry", "forbidden", "unacknowledged"]) {
  test(`exact interrupted Muse recovery: ${outcome}`, async () => {
    const selected = request("ready", { contextEventId: "ctx-ready", progressState: "acknowledged",
      progressNote: "Receiving runtime read and verified this exact request; model acceptance is separate." });
    const offer = Object.freeze({ requestMessageId: selected.id, openingEventId: selected.openingEventId,
      roomCreatedEventId: "room-birth", openingSequence: 15, requestRevision: 0,
      offeredAt: "2026-11-20T19:48:01Z",
      ...(outcome === "unacknowledged" ? {} : { receiverAcknowledgment: Object.freeze({ sequence: 16 }) }) });
    let pending = offer;
    const reads = [], drafts = [];
    const stop = new AbortController();
    const refusal = outcome === "forbidden" ? new RoomClientError(403, "forbidden", "Forbidden")
      : new RoomClientError(404, "reply_request_not_found", "Request not found in this Room");
    const run = recoverMuseHandoff({ policy, offers: [offer], currentOffer: () => pending,
      signal: stop.signal, graceMs: 0, record: handoff => drafts.push(handoff),
      delay: async ms => {
        if (ms === 0) return;
        if (outcome === "replaced") pending = { ...offer, offeredAt: "2026-11-20T19:48:02Z" };
        if (outcome === "aborted") stop.abort();
      },
      client: {
        replyContextForHint(id, { signal }) {
          assert.equal(signal, stop.signal);
          reads.push(id);
          if (reads.length === 2 && outcome === "replaced_during_retry") pending = null;
          if (reads.length === 2 && outcome === "aborted_during_retry") stop.abort();
          if (outcome !== "readable" || reads.length === 1) throw refusal;
          return context(selected, 15);
        },
        command: () => assert.fail("recovery must never acknowledge or start work again")
      }
    });
    if (outcome === "readable") {
      const replay = await run;
      assert.equal(replay.requestMessageId, offer.requestMessageId);
      assert.deepEqual(replay.receiverAcknowledgment, offer.receiverAcknowledgment);
      assert.equal(drafts.length, 1);
    } else {
      if (["replaced", "replaced_during_retry"].includes(outcome)) assert.equal(await run, undefined);
      else if (["aborted", "aborted_during_retry"].includes(outcome)) await assert.rejects(run, { name: "AbortError" });
      else if (outcome === "missing") await assert.rejects(run, { code: "offer_unreadable" });
      else await assert.rejects(run, error => error === refusal);
      assert.deepEqual(drafts, []);
    }
    const expectedReads = ["readable", "missing", "replaced_during_retry", "aborted_during_retry"].includes(outcome) ? 2 : 1;
    assert.deepEqual(reads, Array(expectedReads).fill(offer.requestMessageId));
    if (!["replaced", "replaced_during_retry"].includes(outcome)) assert.equal(pending, offer);
  });
}

test("interrupted recovery drops an offer cleared during its exact read", async () => {
  const selected = request("ready", { contextEventId: "ctx-ready", progressState: "acknowledged",
    progressNote: "Receiving runtime read and verified this exact request; model acceptance is separate." });
  const original = { requestMessageId: "ready", openingEventId: "open-ready", openingSequence: 15,
    roomCreatedEventId: "room-birth", offeredAt: "2026-11-20T19:48:01Z", receiverAcknowledgment: { sequence: 16 } };
  for (const replacement of [null, { ...original, offeredAt: "2026-11-20T19:48:02Z" }]) {
    let pending = original;
    const result = await recoverMuseHandoff({ policy, signal: new AbortController().signal, offers: [original],
      currentOffer: () => pending, delay: async () => {},
      client: { async replyContextForHint() { pending = replacement; return context(selected, 15); } },
      record: () => assert.fail("same request does not mean the same local offer")
    });
    assert.equal(result, undefined);
  }
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
  const ask = request("signed-off", {contextEventId: "ctx-1"});
  let checkpoint = {after: 10, inFlight: null};
  let progress = {};
  const calls = [];
  const client = {
    replyRequests: () => ({evaluatedThrough: 10, requests: [ask]}),
    replyContext: () => context({...ask, ...progress}, 11),
    command(command) {
      assert.equal(checkpoint.inFlight.requestMessageId, ask.id);
      assert.equal(command.type, "reply_request.progressed");
      assert.equal(command.data.progress, "acknowledged");
      assert.equal(command.data.ifUnacknowledgedContextEventId, "ctx-1");
      calls.push(command);
      // A clarification after our recorded ack must not change the replayed write.
      progress = {acknowledgedAt: "2026-11-19T00:00:00Z", progressState: "acknowledged", progressNote: command.data.note, contextEventId: "ctx-2"};
      if (calls.length === 1) throw new TypeError("Response interrupted");
      return {event: {id: "ack-event"}, sequence: 12, duplicate: true};
    }
  };
  const run = () => holdMuseHandoff({client, policy, checkpoint, receiverAck: true,
    signal: new AbortController().signal, save(state) { checkpoint = state; }});
  await assert.rejects(run(), /interrupted/);
  const recovered = await run();
  assert.equal(recovered.receiverAcknowledgment.sequence, 12);
  assert.equal(recovered.receiverAcknowledgment.duplicate, true);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(recovered.contextEventId, undefined);
});

test("receiver acknowledgment is refused for an inspected context that changed, then records once after re-read", async () => {
  const ask = request("corrected", {contextEventId: "ctx-old"});
  let checkpoint = {after: 10, inFlight: null}, serverContext = "ctx-old", recorded = 0;
  const sent = [];
  const client = {
    replyRequests: () => ({evaluatedThrough: 10, requests: [ask]}),
    replyContext: () => context({...ask, contextEventId: serverContext, ...(recorded ? {acknowledgedAt: "t", progressState: "acknowledged", progressNote: sent.at(-1).data.note} : {})}, 11),
    command(command) {
      sent.push(command);
      if (sent.length === 1) serverContext = "ctx-new"; // clarification lands between read and write
      if (command.data.ifUnacknowledgedContextEventId !== serverContext)
        throw Object.assign(Error("Read the current addressed request before acknowledging"), {status: 409, code: "request_context_changed"});
      recorded++;
      return {event: {id: "ack"}, sequence: 13, duplicate: false};
    }
  };
  const run = () => holdMuseHandoff({client, policy, checkpoint, receiverAck: true,
    signal: new AbortController().signal, save(state) { checkpoint = state; }});
  await assert.rejects(run(), /current addressed request/);
  assert.equal(recorded, 0);
  const second = await run();
  assert.equal(sent[1].data.ifUnacknowledgedContextEventId, "ctx-new");
  assert.equal(second.receiverAcknowledgment.duplicate, false);
  assert.equal(recorded, 1);
});

test("a stale refusal, a committed re-read ack with a lost response and a restart replay the re-read context", async () => {
  const ask = request("combined", {contextEventId: "ctx-A"});
  let checkpoint = {after: 10, inFlight: null}, serverContext = "ctx-A", ack = null;
  const ops = new Map(), sent = [];
  const client = {
    replyRequests: () => ({evaluatedThrough: 10, requests: [ask]}),
    replyContext: () => context({...ask, contextEventId: serverContext,
      ...(ack ? {acknowledgedAt: "t", progressState: "acknowledged", progressNote: ack.note} : {})}, 11),
    command(command) {
      sent.push(command);
      const fingerprint = JSON.stringify(command.data), prior = ops.get(command.id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw Object.assign(Error("Operation ID reused with different input"), {status: 409, code: "idempotency_conflict"});
        return {event: {id: prior.eventId}, sequence: prior.sequence, duplicate: true};
      }
      if (sent.length === 1) serverContext = "ctx-B"; // clarification B lands at the same revision
      if (command.data.ifUnacknowledgedContextEventId !== serverContext)
        throw Object.assign(Error("Read the current addressed request before acknowledging"), {status: 409, code: "request_context_changed"});
      ack = command.data; ops.set(command.id, {fingerprint, eventId: "ack-B", sequence: 14});
      throw new TypeError("Response interrupted"); // committed, response lost
    }
  };
  const run = () => holdMuseHandoff({client, policy, checkpoint, receiverAck: true,
    signal: new AbortController().signal, save(state) { checkpoint = state; }});
  await assert.rejects(run(), /current addressed request/);
  assert.equal(ack, null);
  await assert.rejects(run(), /interrupted/);
  assert.equal(sent[1].data.ifUnacknowledgedContextEventId, "ctx-B");
  assert.equal(checkpoint.inFlight.contextEventId, "ctx-B", "the re-read context is checkpointed before the write");
  const recovered = await run();
  assert.deepEqual(sent[2], sent[1]);
  assert.equal(recovered.receiverAcknowledgment.duplicate, true);
  assert.equal(recovered.receiverAcknowledgment.sequence, 14);
  assert.equal(ops.size, 1);
});
