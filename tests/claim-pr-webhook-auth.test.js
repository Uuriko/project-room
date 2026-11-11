// RES-0140 (AP-1 T2-L04a-C9): applyPullRequestWebhook was an
// unauthenticated settlement export that enumerated the whole claim
// registry per call — any direct caller could settle claims with a
// fabricated pull_request payload, and one call decoded every claim in
// every room. The export now verifies the delivery itself with the same
// HMAC verifier and secret the PR webhook route uses
// (server/github-app/verify.mjs, GITHUB_PR_WEBHOOK_SECRET), refuses
// unverified calls before touching the store, and SQL-selects only the
// claims linked to the payload's pull URL.
//
// These tests run the real boundary: a real RoomStore, claims created
// and claimed through the real work-claim routes, settlement attempted
// through the export exactly as a direct caller would.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { applyPullRequestWebhook } from "../server/claim-pr-sync.mjs";
import { handlePrWebhookPayload, PR_WEBHOOK_SECRET_ENV } from "../server/claim-autolink.mjs";
import { ClaimError } from "../server/work-claims.mjs";

const URL_A = "https://github.com/Uuriko/project-room/pull/7";
const SECRET = "res-0140-fixture-secret";
const PAYLOAD = { action: "closed", pull_request: { html_url: URL_A, merged: true, state: "closed" } };

// The export reads its secret from the env, exactly as the route does;
// the caller presents only the raw body and its signature header.
const sign = (payload, signingKey = SECRET) => {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    signature256: "sha256=" + createHmac("sha256", signingKey).update(rawBody).digest("hex"),
    env: { [PR_WEBHOOK_SECRET_ENV]: SECRET },
  };
};

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (route, id, body) => handleWorkClaims({
    req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
    res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons",
    auth: { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers,
    registry: store.workClaims,
    githubToken: null,
  });
  await call("create", null, { id: "target", files: ["docs/a.md"], pullRequest: URL_A });
  await call("claim", "target", {});
  await call("create", null, { id: "template", files: ["docs/t.md"] });
  const template = store.workClaims.get("commons", "template");
  store.workClaims.set("room-b", { ...template, id: "bystander-b" });
  store.workClaims.set("room-c", { ...template, id: "bystander-c" });
  store.workClaims.set("room-c", { ...template, id: "bystander-c2" });
  // Instrument registry reads from here on: the export's own reads are
  // what these tests measure, so seeding reads stay out of the counts.
  const reads = { list: [], get: [] };
  const originalList = store.workClaims.list.bind(store.workClaims);
  const originalGet = store.workClaims.get.bind(store.workClaims);
  store.workClaims.list = (roomId, ...rest) => { reads.list.push(roomId); return originalList(roomId, ...rest); };
  store.workClaims.get = (roomId, claimId, ...rest) => { reads.get.push(`${roomId}/${claimId}`); return originalGet(roomId, claimId, ...rest); };
  return { store, reads };
}

test("an unauthenticated call is refused before the store is touched", async t => {
  const { store, reads } = await fixture(t);
  const out = await applyPullRequestWebhook(store, PAYLOAD);
  assert.deepEqual(out.applied, []);
  assert.equal(out.refused, "missing_signature");
  const item = store.workClaims.get("commons", "target");
  assert.equal(item.state, "claimed");
  assert.equal(item.pullRequest.outcome, null);
  assert.deepEqual(reads.list, [], "no registry enumeration");
  assert.deepEqual(reads.get.filter(entry => entry !== "commons/target"), [], "no bystander reads");
});

test("a forged signature is refused, and a divergent payload object cannot override the signed body", async t => {
  const { store } = await fixture(t);
  const forged = await applyPullRequestWebhook(store, PAYLOAD, sign(PAYLOAD, "some-other-secret"));
  assert.deepEqual(forged.applied, []);
  assert.equal(forged.refused, "mismatch");
  assert.equal(store.workClaims.get("commons", "target").state, "claimed");
  // The caller passes a payload object claiming the PR closed unmerged,
  // but the signed body says merged: the signed body governs, so the
  // claim settles as merged — the unsigned object settles nothing.
  const divergent = await applyPullRequestWebhook(store,
    { ...PAYLOAD, pull_request: { ...PAYLOAD.pull_request, merged: false } }, sign(PAYLOAD));
  assert.deepEqual(divergent.applied, [{ roomId: "commons", claimId: "target", outcome: "merged" }]);
  const item = store.workClaims.get("commons", "target");
  assert.equal(item.state, "done");
  assert.equal(item.pullRequest.outcome, "merged");
});

test("a signature-valid delivery settles, decoding only the linked claims", async t => {
  const { store, reads } = await fixture(t);
  const out = await applyPullRequestWebhook(store, PAYLOAD, sign(PAYLOAD));
  assert.deepEqual(out.applied, [{ roomId: "commons", claimId: "target", outcome: "merged" }]);
  const item = store.workClaims.get("commons", "target");
  assert.equal(item.state, "done");
  assert.equal(item.pullRequest.outcome, "merged");
  assert.deepEqual(reads.list, [], "settlement never lists a room's claims");
  assert.ok(reads.get.every(entry => entry === "commons/target"),
    `only the linked claim is decoded, got: ${reads.get.join(", ")}`);
  // A replay of the same genuine delivery is inert (link already settled).
  const replay = await applyPullRequestWebhook(store, PAYLOAD, sign(PAYLOAD));
  assert.deepEqual(replay.applied, []);
});

test("the webhook core cannot settle without the forwarded delivery material", async t => {
  const { store } = await fixture(t);
  const unsigned = await handlePrWebhookPayload(store, PAYLOAD, {});
  assert.equal(unsigned.ok, true);
  assert.deepEqual(unsigned.settled, []);
  assert.equal(store.workClaims.get("commons", "target").state, "claimed");
  const signed = await handlePrWebhookPayload(store, PAYLOAD, { webhook: sign(PAYLOAD) });
  assert.equal(signed.ok, true);
  assert.deepEqual(signed.settled, [{ roomId: "commons", claimId: "target", outcome: "merged" }]);
  assert.equal(store.workClaims.get("commons", "target").state, "done");
});

test("a durable unrelated scalar pull link cannot block signed settlement", async t => {
  const { store } = await fixture(t);
  store.workClaims.set("room-b", {
    ...store.workClaims.get("room-b", "bystander-b"), pullRequests: ["unrelated-scalar"],
  });
  const out = await applyPullRequestWebhook(store, PAYLOAD, sign(PAYLOAD));
  assert.deepEqual(out.applied, [{ roomId: "commons", claimId: "target", outcome: "merged" }]);
});

for (const format of ["envelope", "legacy"]) {
  test(`signed settlement ignores unrelated mixed pull elements (${format})`, async t => {
    const { store, reads } = await fixture(t);
    const target = store.workClaims.get("commons", "target");
    const mixed = ["unrelated-scalar", 42, true, false, null, "{", [],
      JSON.stringify(target.pullRequest), { url: "https://github.com/Uuriko/project-room/pull/999" }];
    // Use the real durable writer: it accepts these historical element shapes.
    store.workClaims.set("room-b", {
      ...store.workClaims.get("room-b", "bystander-b"), pullRequests: mixed,
    });
    // The target must be found through the array branch, not the singular fallback.
    store.workClaims.set("commons", { ...target, pullRequest: null, pullRequests: [target.pullRequest] });
    if (format === "legacy") {
      for (const [roomId, claimId] of [["commons", "target"], ["room-b", "bystander-b"]]) {
        const raw = store.db.prepare("SELECT item_json FROM work_claims WHERE room_id=? AND claim_id=?").get(roomId, claimId);
        store.db.prepare("UPDATE work_claims SET item_json=? WHERE room_id=? AND claim_id=?")
          .run(JSON.stringify(JSON.parse(raw.item_json).data), roomId, claimId);
      }
    }
    const snapshot = () => store.db.prepare("SELECT * FROM work_claims ORDER BY room_id, claim_id").all();
    const before = snapshot();
    reads.get.length = 0;
    const refused = await applyPullRequestWebhook(store, PAYLOAD, sign(PAYLOAD, "wrong-key"));
    assert.equal(refused.refused, "mismatch");
    assert.deepEqual(snapshot(), before, "unverified delivery changes no durable row");
    assert.deepEqual(reads.get, [], "unverified delivery decodes no claims");
    const out = await applyPullRequestWebhook(store, PAYLOAD, sign(PAYLOAD));
    assert.deepEqual(out.applied, [{ roomId: "commons", claimId: "target", outcome: "merged" }]);
    assert.ok(reads.get.every(entry => entry === "commons/target"), "mixed elements never select a bystander");
    assert.deepEqual(snapshot().filter(row => row.claim_id !== "target"), before.filter(row => row.claim_id !== "target"));
    assert.equal(store.workClaims.get("commons", "target").state, "done");
  });
}

test("unsupported stored record shapes cannot poison unrelated signed settlement", async t => {
  const { store } = await fixture(t);
  // Corrupt JSON cannot normally pass the writer's expression indexes. Remove
  // those indexes only in this corruption fixture to exercise read admission.
  for (const { name, sql } of store.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='work_claims'").all()) {
    if (sql?.includes("json_")) store.db.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
  }
  // The normalized-storage admission guards also inspect JSON. Suspend only
  // those guards while injecting impossible rows, then restore their exact SQL
  // before exercising settlement. Production admission is not weakened.
  const guards = store.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='work_claims'")
    .all().filter(row => row.name.startsWith('current_room_guard_') && row.sql.includes('json_'));
  assert.ok(guards.length > 0, 'the corruption fixture must encounter normalized admission guards');
  for (const { name } of guards) store.db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  const shapes = ["{", "null", "42", "true", '"scalar"', "[]", '{"v":1,"kind":"work-claim","data":"scalar"}',
    '{"pullRequests":"scalar","data":{"pullRequests":42}}'];
  for (const [index, item] of shapes.entries()) {
    store.db.prepare("INSERT INTO work_claims(room_id,claim_id,item_json,updated_at) VALUES(?,?,?,?)")
      .run("room-b", `unsupported-${index}`, item, "2026-11-01T00:00:00Z");
  }
  for (const { sql } of guards) store.db.exec(sql);
  for (const { name, sql } of guards) assert.equal(
    store.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql, sql);
  const before = store.db.prepare("SELECT * FROM work_claims WHERE room_id='room-b' ORDER BY claim_id").all();
  const out = await applyPullRequestWebhook(store, PAYLOAD, sign(PAYLOAD));
  assert.deepEqual(out.applied, [{ roomId: "commons", claimId: "target", outcome: "merged" }]);
  assert.deepEqual(store.db.prepare("SELECT * FROM work_claims WHERE room_id='room-b' ORDER BY claim_id").all(), before);
});

for (const stage of ["selector", "event-write", "unexpected-event-write"]) {
  test(`autolink commit survives ${stage} failure and exact retry settles once`, async t => {
    const { store } = await fixture(t);
    const target = store.workClaims.get("commons", "target");
    store.workClaims.set("commons", { ...target, repo: "Uuriko/project-room", branch: "target", pullRequest: null, pullRequests: [] });
    const payload = { ...PAYLOAD, repository: { full_name: "Uuriko/project-room" },
      pull_request: { ...PAYLOAD.pull_request, head: { ref: "target" }, title: "target" } };
    const options = { webhook: sign(payload) }, before = store.headSequence("commons");
    const prepare = store.db.prepare.bind(store.db);
    const fault = stage === "unexpected-event-write" ? new Error("unexpected event implementation failure")
      : Object.assign(new Error("synthetic event storage fault"), { code: "EIO" });
    let armed = true, settlement = false, injected = false;
    store.db.prepare = sql => {
      if (sql.includes("SELECT room_id AS roomId, claim_id AS claimId") && sql.includes("WHERE CASE WHEN json_valid(item_json)")) {
        settlement = true;
        if (stage === "selector" && armed) { armed = false; injected = true; throw fault; }
      }
      if (stage !== "selector" && settlement && armed && /INSERT INTO events\b/.test(sql)) {
        armed = false; injected = true; throw fault;
      }
      return prepare(sql);
    };
    await assert.rejects(handlePrWebhookPayload(store, payload, options), error => error === fault || error.cause === fault);
    assert.ok(injected);
    const linked = store.workClaims.get("commons", "target");
    assert.equal(linked.state, "claimed");
    assert.equal(linked.pullRequest.outcome, null);
    assert.equal(linked.history.filter(entry => entry.action === "pr_autolinked").length, 1);
    assert.equal(store.headSequence("commons"), before + 1, "only the committed autolink event remains");
    const retry = await handlePrWebhookPayload(store, payload, options);
    assert.equal(retry.linked, null);
    assert.deepEqual(retry.settled, [{ roomId: "commons", claimId: "target", outcome: "merged" }]);
    assert.equal(store.headSequence("commons"), before + 2);
    const done = store.workClaims.get("commons", "target");
    assert.equal(done.state, "done");
    assert.deepEqual((await handlePrWebhookPayload(store, payload, options)).settled, []);
    assert.deepEqual(store.workClaims.get("commons", "target"), done);
    assert.equal(store.headSequence("commons"), before + 2);
  });
}

for (const lateFailure of [false, true]) {
  test(`known invalid claim is skipped without partial mutation (late=${lateFailure})`, async t => {
    const { store } = await fixture(t), target = store.workClaims.get("commons", "target");
    store.workClaims.set("commons", { ...target, id: "bad", ...(lateFailure ? {} : { kind: "land", repo: "https://github.com/Uuriko/project-room" }) });
    const before = store.workClaims.get("commons", "bad");
    if (lateFailure) {
      const set = store.workClaims.set.bind(store.workClaims);
      store.workClaims.set = (roomId, item) => {
        set(roomId, item);
        if (item.id === "bad" && item.state === "done") throw new ClaimError("invalid_claim_input", "late claim validation refusal");
      };
    }
    const out = await applyPullRequestWebhook(store, PAYLOAD, sign(PAYLOAD));
    assert.deepEqual(out.applied, [{ roomId: "commons", claimId: "target", outcome: "merged" }]);
    assert.deepEqual(store.workClaims.get("commons", "bad"), before, "skipped item never commits a partial outcome");
    assert.equal(store.workClaims.get("commons", "target").state, "done");
  });
}

for (const faultKind of ['invalid-claim', 'storage', 'unexpected']) {
  test(`settlement savepoints publish appends only after outer commit (${faultKind})`, async t => {
    const { store } = await fixture(t), target = store.workClaims.get('commons', 'target');
    store.workClaims.set('commons', { ...target, id: 'bad-middle' });
    store.workClaims.set('commons', { ...target, id: 'good-last' });
    const before = store.db.prepare("SELECT * FROM work_claims WHERE room_id='commons' ORDER BY claim_id").all();
    const head = store.headSequence('commons'), stamp = store.eventStamp('commons'), notifications = [], writes = [];
    store.onEventAppended(roomId => notifications.push({ roomId, inTransaction: store.db.isTransaction, head: store.headSequence(roomId) }));
    const prepare = store.db.prepare.bind(store.db);
    const fault = faultKind === 'invalid-claim' ? new ClaimError('invalid_claim_input', 'late invalid claim')
      : Object.assign(new Error('late settlement fault'), faultKind === 'storage' ? { code: 'EIO' } : {});
    store.db.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.startsWith('INSERT INTO events VALUES')) return statement;
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        const result = run(...args), id = JSON.parse(args[3]).data.workClaim;
        writes.push(id);
        if (id === 'bad-middle') throw fault;
        return result;
      };
      return statement;
    };
    if (faultKind === 'invalid-claim') {
      const out = await applyPullRequestWebhook(store, PAYLOAD, sign(PAYLOAD));
      assert.deepEqual(out.applied.map(item => item.claimId), ['target', 'good-last']);
      assert.deepEqual(writes, ['target', 'bad-middle', 'good-last']);
      assert.equal(store.headSequence('commons'), head + 2);
      assert.equal(store.workClaims.get('commons', 'bad-middle').state, 'claimed');
      assert.equal(store.workClaims.get('commons', 'bad-middle').pullRequest.outcome, null);
      assert.deepEqual(notifications, [{ roomId: 'commons', inTransaction: false, head: head + 2 }]);
      assert.equal(store.eventStamp('commons'), stamp + 1, 'the committed room wakes once');
    } else {
      await assert.rejects(applyPullRequestWebhook(store, PAYLOAD, sign(PAYLOAD)), error => error === fault || error.cause === fault);
      assert.deepEqual(writes, ['target', 'bad-middle']);
      assert.deepEqual(store.db.prepare("SELECT * FROM work_claims WHERE room_id='commons' ORDER BY claim_id").all(), before);
      assert.equal(store.headSequence('commons'), head);
      assert.deepEqual(notifications, [], 'an outer rollback never publishes a committed append');
      assert.equal(store.eventStamp('commons'), stamp);
    }
  });
}
