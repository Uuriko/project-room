import test from "node:test";
import assert from "node:assert/strict";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { workPublishedVerdicts } from "../server/work-context.mjs";
import { readWorkItem } from "../server/work-repository.mjs";

const HEAD = "7af0b60ec794bc717fa5b343cafa755cf6af4232";
const BASE = "b51cccaadea80ba6f81ca9462e97a700bd0337a0";
const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPRESENTATIONS = ["legacy", "normalized-current-v1"];

function fixture(t, representation) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom(), representation === "legacy" ? {} : { representation });
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, command) => store.command(keys[actor], "commons", command);
  for (const [memberId, kind, permissions] of [
    ["guest", "human", []],
    ["agent", "agent", ["accept_work", "complete_work"]],
    ["reviewer", "agent", ["verify"]],
    ["lander", "agent", ["accept_work"]]
  ]) {
    send("owner", { id: `add-${memberId}`, type: "member.added", data: { memberId, displayName: memberId, kind, permissions } });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  for (const memberId of ["agent", "reviewer", "lander"])
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  for (const a of ["owner", "guest", "agent", "reviewer", "lander"])
    for (const b of ["owner", "guest", "agent", "reviewer", "lander"])
      if (a !== b) {
        store.dmConsents.request("commons", a, b, "test fixture");
        store.dmConsents.decide("commons", b, a, "approve");
      }
  send("owner", { id: "propose-qualify", type: "work.proposed", data: {
    workItemId: "qualify-work", title: "Qualify a source change",
    definitionOfDone: "An independent verifier publishes a readable source verdict",
    accountableMemberId: "agent", verifierMemberId: "reviewer", mode: "read",
    independentVerificationRequired: true
  } });
  return { store, keys, send, representation };
}

function inviteLander(send) {
  send("owner", { id: "ask-lander", type: "message.posted", data: {
    messageId: "ask-lander", body: "Please source-land once a published verdict is readable.",
    toMemberId: "lander", workItemId: "qualify-work", requestKind: "reply"
  } });
}

const PUBLICATION = {
  workItemId: "qualify-work",
  repository: "Uuriko/project-room",
  pullNumber: 6392,
  head: HEAD,
  base: BASE,
  verdict: "pass",
  summary: "Exact-head source pass on the published tuple.",
  evidenceDigest: DIGEST
};

function publishVerdict(send, extras = {}) {
  return send("reviewer", { id: extras.id ?? "publish-verdict", type: "work.verdict_published", data: {
    ...PUBLICATION,
    ...extras.data
  } });
}

function expectedPublication(published, extras = {}) {
  return {
    eventId: published.event.id,
    publisherId: "reviewer",
    repository: "Uuriko/project-room",
    pullNumber: 6392,
    head: HEAD,
    base: BASE,
    verdict: extras.verdict ?? "pass",
    summary: extras.summary ?? "Exact-head source pass on the published tuple.",
    evidenceDigest: DIGEST,
    at: published.event.at
  };
}

function assertPublicationCommand(published, data = PUBLICATION) {
  assert.equal(published.event.type, "work.verdict_published");
  assert.equal(published.event.actorId, "reviewer");
  assert.equal(published.event.data.workItemId, data.workItemId);
  assert.equal(published.event.data.repository, data.repository);
  assert.equal(published.event.data.pullNumber, data.pullNumber);
  assert.equal(published.event.data.head, data.head);
  if (data.base !== undefined) assert.equal(published.event.data.base, data.base);
  assert.equal(published.event.data.verdict, data.verdict);
  assert.equal(published.event.data.summary, data.summary);
  if (data.evidenceDigest !== undefined) assert.equal(published.event.data.evidenceDigest, data.evidenceDigest);
}

function addressedVerdicts(store, token) {
  return store.workContext(token, "commons", "qualify-work").publishedVerdicts;
}

async function eventsFor(origin, token) {
  const res = await fetch(`${origin}/api/rooms/commons/events?after=0&limit=100`, {
    headers: { Authorization: "Bearer " + token }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.events ?? [];
}

function verdictEvents(rows) {
  return rows.filter(row => (row.event?.type ?? row.type) === "work.verdict_published");
}

function isCurrentAddressedReadGuard(error) {
  return error?.status === 409 && error?.code === "current_room_context_required";
}

async function withServer(t, store, run) {
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await run(`http://127.0.0.1:${server.address().port}`);
}

for (const representation of REPRESENTATIONS) {
  test(`a published verdict is visible to a work reader (${representation})`, t => {
    const f = fixture(t, representation);
    const published = publishVerdict(f.send);
    assertPublicationCommand(published);
    inviteLander(f.send);
    const expected = expectedPublication(published);
    const context = f.store.workContext(f.keys.lander, "commons", "qualify-work");
    assert.deepEqual(context.publishedVerdicts, [expected]);
    assert.deepEqual(workPublishedVerdicts(readWorkItem(f.store.db, "commons", "qualify-work")), [expected]);
    assert.equal("independentVerdicts" in context, false);
    const serialized = JSON.stringify(context);
    assert.equal(serialized.includes(f.keys.lander), false);
    assert.equal(serialized.includes(f.keys.owner), false);
    assert.equal(serialized.includes(f.keys.reviewer), false);
  });

  test(`a non-reader can't see a published verdict (${representation})`, async t => {
    const f = fixture(t, representation);
    const published = publishVerdict(f.send);
    assertPublicationCommand(published);
    inviteLander(f.send);
    assert.throws(() => f.store.workContext(f.keys.guest, "commons", "qualify-work"), { status: 403, code: "work_private" });
    const context = f.store.workContext(f.keys.lander, "commons", "qualify-work");
    assert.deepEqual(context.publishedVerdicts, [expectedPublication(published)]);

    await withServer(t, f.store, async origin => {
      const [landerRows, guestRows] = await Promise.all([
        eventsFor(origin, f.keys.lander),
        eventsFor(origin, f.keys.guest)
      ]);
      const landerVerdict = verdictEvents(landerRows);
      const guestVerdict = verdictEvents(guestRows);
      assert.equal(landerVerdict.length, 1);
      assert.equal(landerVerdict[0].event.data.summary, PUBLICATION.summary);
      assert.equal(landerVerdict[0].event.data.head, HEAD);
      assert.equal(landerVerdict[0].event.data.verdict, "pass");
      assert.equal(guestVerdict.length, 1);
      assert.equal(guestVerdict[0].event.data.withheld, true);
      assert.equal(guestVerdict[0].event.data.summary, undefined);
      assert.equal(guestVerdict[0].event.data.head, undefined);
      assert.equal(guestVerdict[0].event.data.verdict, undefined);
      assert.equal(guestVerdict[0].event.data.evidenceDigest, undefined);
      assert.equal(JSON.stringify(guestVerdict).includes("Exact-head source pass"), false);
    });
  });

  test(`a private request answer by the verifier is not projected (${representation})`, async t => {
    const f = fixture(t, representation);
    const secretNote = `session token ${f.keys.owner}`;
    f.send("reviewer", { id: "private-chatter", type: "message.posted", data: {
      messageId: "private-chatter", body: secretNote, toMemberId: "owner"
    } });
    const ask = f.send("owner", { id: "ask-verdict", type: "message.posted", data: {
      messageId: "ask-verdict", body: "Please give an exact-head source verdict on the candidate.",
      toMemberId: "reviewer", workItemId: "qualify-work", requestKind: "reply"
    } });
    f.send("reviewer", { id: "answer-verdict", type: "message.posted", data: {
      messageId: "answer-verdict",
      body: "SOURCE PASS on the exact head. Recovery and the contract pin both hold.",
      responseToRequestId: "ask-verdict", expectedRequestRevision: 0, responseOutcome: "answered",
      contextEventId: ask.event.id, contextSequence: ask.sequence,
      replyToId: "ask-verdict", toMemberId: "owner", workItemId: "qualify-work"
    } });
    inviteLander(f.send);

    const context = f.store.workContext(f.keys.lander, "commons", "qualify-work");
    assert.deepEqual(context.publishedVerdicts, []);
    const serialized = JSON.stringify(context);
    assert.equal(serialized.includes("SOURCE PASS"), false);
    assert.equal(serialized.includes("Recovery and the contract pin both hold"), false);
    assert.equal(serialized.includes(secretNote), false);
    assert.equal("independentVerdicts" in context, false);

    // Private discussion reads on current rooms still require an addressed
    // discussion path; the pre-existing current_room_context_required guard
    // is out of scope for this verdict publication.
    try {
      const discussion = f.store.workDiscussion(f.keys.lander, "commons", "qualify-work");
      assert.equal(discussion.discussion.items.some(row =>
        row.message?.id === "answer-verdict" || row.message?.id === "ask-verdict" || row.message?.id === "private-chatter"), false);
    } catch (error) {
      assert.equal(representation, "normalized-current-v1");
      assert.equal(isCurrentAddressedReadGuard(error), true);
    }

    await withServer(t, f.store, async origin => {
      const messageIds = rows => rows.map(row => row.event?.data?.messageId ?? row.data?.messageId ?? row.messageId);
      const landerIds = messageIds(await eventsFor(origin, f.keys.lander));
      const guestIds = messageIds(await eventsFor(origin, f.keys.guest));
      const reviewerIds = messageIds(await eventsFor(origin, f.keys.reviewer));
      assert.equal(landerIds.includes("ask-lander"), true);
      for (const ids of [landerIds, guestIds]) {
        assert.equal(ids.some(id => ["ask-verdict", "answer-verdict", "private-chatter"].includes(id)), false);
      }
      assert.equal(reviewerIds.includes("answer-verdict"), true);
      assert.equal(reviewerIds.includes("private-chatter"), true);
    });
  });

  test(`a non-verifier can't publish a work verdict (${representation})`, t => {
    const f = fixture(t, representation);
    const data = {
      workItemId: "qualify-work",
      repository: "Uuriko/project-room",
      pullNumber: 6392,
      head: HEAD,
      verdict: "pass",
      summary: "Should be rejected."
    };
    assert.throws(
      () => f.send("lander", { id: "lander-publish", type: "work.verdict_published", data }),
      /Only the designated verifier or a member with verify permission may publish a work verdict/
    );
    assert.throws(
      () => f.send("agent", { id: "agent-publish", type: "work.verdict_published", data }),
      /Only the designated verifier or a member with verify permission may publish a work verdict/
    );
    assert.throws(
      () => f.send("guest", { id: "guest-publish", type: "work.verdict_published", data }),
      /Only the designated verifier or a member with verify permission may publish a work verdict/
    );
    assert.deepEqual(workPublishedVerdicts(readWorkItem(f.store.db, "commons", "qualify-work")), []);
    assert.deepEqual(addressedVerdicts(f.store, f.keys.agent), []);
  });

  test(`the source tuple is required and exact (${representation})`, t => {
    const f = fixture(t, representation);
    const base = {
      workItemId: "qualify-work",
      repository: "Uuriko/project-room",
      pullNumber: 6392,
      head: HEAD,
      verdict: "hold",
      summary: "Tuple must be exact."
    };
    const reject = (id, data, pattern) => {
      assert.throws(() => f.send("reviewer", { id, type: "work.verdict_published", data: { ...base, ...data } }), pattern);
    };
    reject("missing-repo", { repository: "" }, /Invalid repository|Event data missing repository/);
    reject("missing-pr", { pullNumber: null }, /Invalid pullNumber|Event data missing pullNumber/);
    reject("string-pr", { pullNumber: "6392" }, /Invalid field: pullNumber|pullNumber must be the exact positive integer PR number/);
    reject("zero-pr", { pullNumber: 0 }, /pullNumber must be the exact positive integer PR number/);
    reject("missing-head", { head: "" }, /Invalid head|Event data missing head/);
    reject("short-head", { head: "7af0b60e" }, /head must be the exact 40-character lowercase source SHA/);
    reject("upper-head", { head: HEAD.toUpperCase() }, /head must be the exact 40-character lowercase source SHA/);
    reject("short-base", { base: "b51cccaa" }, /base must be the exact 40-character lowercase source SHA when provided/);
    reject("bad-verdict", { verdict: "approved" }, /Unsupported work verdict/);
    reject("missing-summary", { summary: "  " }, /Invalid summary|Event data missing summary/);
    reject("bad-digest", { evidenceDigest: "not-a-digest" }, /evidenceDigest must be sha256:<64 lowercase hex> when provided/);
    const data = { ...base, base: BASE, evidenceDigest: DIGEST };
    const published = f.send("reviewer", { id: "exact-tuple", type: "work.verdict_published", data });
    assertPublicationCommand(published, data);
    const expected = expectedPublication(published, { verdict: "hold", summary: "Tuple must be exact." });
    assert.deepEqual(addressedVerdicts(f.store, f.keys.agent), [expected]);
  });

  test(`no PASS is inferred from an answered request (${representation})`, t => {
    const f = fixture(t, representation);
    const ask = f.send("owner", { id: "ask-verdict", type: "message.posted", data: {
      messageId: "ask-verdict", body: "Please verdict this head.",
      toMemberId: "reviewer", workItemId: "qualify-work", requestKind: "reply"
    } });
    f.send("reviewer", { id: "answer-verdict", type: "message.posted", data: {
      messageId: "answer-verdict",
      body: "SOURCE PASS on 7af0b60ec794bc717fa5b343cafa755cf6af4232.",
      responseToRequestId: "ask-verdict", expectedRequestRevision: 0, responseOutcome: "answered",
      contextEventId: ask.event.id, contextSequence: ask.sequence,
      replyToId: "ask-verdict", toMemberId: "owner", workItemId: "qualify-work"
    } });
    inviteLander(f.send);
    const context = f.store.workContext(f.keys.lander, "commons", "qualify-work");
    assert.deepEqual(context.publishedVerdicts, []);
    assert.equal(context.work.verification, null);
    const serialized = JSON.stringify(context);
    assert.equal(serialized.includes('"verdict":"pass"'), false);
    assert.equal(serialized.includes("SOURCE PASS"), false);
  });
}

for (const representation of REPRESENTATIONS) {
  test(`public authored source verdict uses the integrator's exact agent read (${representation})`, async t => {
    const f = fixture(t, representation);
    inviteLander(f.send);
    const ask = f.send("owner", { id: "private-qualify", type: "message.posted", data: {
      messageId: "private-qualify", body: "Private question marker", toMemberId: "reviewer",
      workItemId: "qualify-work", requestKind: "reply"
    } });
    f.send("reviewer", { id: "private-qualify-answer", type: "message.posted", data: {
      messageId: "private-qualify-answer", body: "Private answer marker", responseToRequestId: "private-qualify",
      expectedRequestRevision: 0, responseOutcome: "answered", contextEventId: ask.event.id,
      contextSequence: ask.sequence, replyToId: "private-qualify", toMemberId: "owner", workItemId: "qualify-work"
    } });
    const read = (actor, brief, knownBriefVersion) => callHostedStdioTool(f.store, f.keys[actor], "room_read_work", {
      roomId: "commons", workItemId: "qualify-work", brief, ...(knownBriefVersion ? { knownBriefVersion } : {})
    });
    const before = await read("lander", false);
    assert.equal(before.isError, false);
    assert.deepEqual(before.value.publishedVerdicts, []);
    const beforeBrief = await read("lander", true);
    const seq = f.store.headSequence("commons");
    const committed = publishVerdict(f.send);
    assert.equal(publishVerdict(f.send).event.id, committed.event.id);
    assert.equal(f.store.headSequence("commons"), seq + 1);
    const full = await read("lander", false);
    assert.equal(full.isError, false);
    assert.deepEqual(full.value.publishedVerdicts, [expectedPublication(committed)]);
    assert.equal(full.value.work.verification, null);
    assert.doesNotMatch(JSON.stringify(full.value), /Private (question|answer) marker/);
    await assert.rejects(read("guest", false), { status: 403, code: "work_private" });
    const brief = await read("lander", true, beforeBrief.value.briefVersion);
    assert.equal(brief.isError, false);
    assert.doesNotMatch(JSON.stringify(brief.value), /Private (question|answer) marker/);
    const expected = expectedPublication(committed);
    delete expected.summary;
    assert.deepEqual(brief.value.publishedVerdicts, [expected]);
    assert.notEqual(brief.value.briefVersion, beforeBrief.value.briefVersion);
    assert.equal((await read("lander", true, brief.value.briefVersion)).value.briefUnchanged, true);
    for (let i = 0; i < 4; i++) publishVerdict(f.send, {id: "additional-" + i, data: {head: String(i + 1).repeat(40)}});
    const bounded = await read("lander", true);
    assert.deepEqual(bounded.value.publishedVerdicts.map(item => item.head), ["2", "3", "4"].map(i => i.repeat(40)));
  });
}
