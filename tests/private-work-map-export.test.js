// Two reads the private-work surface matrix had not exercised: the room_map
// tool and the owner-only room export. Both run against the real server and
// the shared private-work fixture, on both storage representations.
//
// room_map answers from the published code graph (project_maps) only. It takes
// no work record, so its privacy property is narrower than the other surfaces:
// every member gets the same answer, and that answer holds no task content.
//
// The export is owner-only. The fixture's owner proposed the private task and
// is a party to its private request, so the owner is entitled to that content.
// What an owner who is NOT a participant should receive is a policy question
// this file does not settle; that case is reported as a diagnostic.
import test from "node:test";
import assert from "node:assert/strict";
import { privateWorkFixture, privateMarkers, PRIVATE, PUBLIC } from "./helpers/private-work-fixture.mjs";

const MAP_REPO = "acme/widgets";
const helper = "export function helper() { return 1; }\n";
const caller = "import { helper } from \"./a.js\";\nexport function run() { return helper(); }\n";
const VIEWERS = ["observer", "triage", "broad", "producer", "reviewer"];
const ownerOf = f => ({ secret: f.owner });
const raw = (f, who, path, init = {}) => fetch(`${f.origin}/api/rooms/commons${path}`, { ...init, headers: { Authorization: `Bearer ${who.secret}`, ...(init.headers ?? {}) } });

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`${representation}: room_map answers from the code graph alone, identically for every member`, async t => {
    const f = await privateWorkFixture(t, representation);
    // Before any graph is published the tool reports that, for everyone.
    for (const viewer of VIEWERS) {
      const empty = await f.mcp(f[viewer], "room_map", { op: "hotspots" });
      assert.ok(empty.ok, `${viewer} can call room_map`);
      assert.equal(empty.value.found, false);
    }
    const published = await raw(f, ownerOf(f), "/map", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: MAP_REPO, revision: "abc", files: [{ path: "a.js", source: helper }, { path: "b.js", source: caller }] }) });
    const before = f.stored();
    if (representation !== "legacy") {
      // Normalized storage refuses map publication, so there is no graph to
      // read: room_map stays at "not found" for everyone. Unsupported, not passed.
      assert.equal(published.status, 409);
      assert.equal((await published.json()).error.code, "current_room_context_required");
      const answers = [];
      for (const viewer of VIEWERS) { const answer = await f.mcp(f[viewer], "room_map", { op: "query", q: PRIVATE.TITLE }); assert.ok(answer.ok); answers.push(JSON.stringify(answer.value)); }
      assert.equal(new Set(answers).size, 1);
      assert.equal(JSON.parse(answers[0]).found, false);
      assert.equal(f.stored(), before);
      return;
    }
    assert.equal(published.status, 200, await published.clone().text());
    for (const args of [{ op: "hotspots" }, { op: "query", q: "helper" }, { op: "explain", q: "a.js" }, { op: "path", from: "b.js", to: "a.js" },
      { op: "query", q: PRIVATE.TITLE }, { op: "query", q: `${PRIVATE.PATH}.js` }, { op: "query", q: "secret" }]) {
      const answers = [];
      for (const viewer of VIEWERS) {
        const answer = await f.mcp(f[viewer], "room_map", args);
        assert.ok(answer.ok, `${viewer} ${args.op}`);
        // The only marker a response may hold is the caller's own query echoed back.
        const echoed = args.q ? privateMarkers(args.q) : [];
        assert.deepEqual(privateMarkers(answer.text).filter(marker => !echoed.includes(marker)), [], `${viewer} ${JSON.stringify(args)}`);
        answers.push(JSON.stringify(answer.value));
      }
      assert.equal(new Set(answers).size, 1, `every member gets the same ${args.op} answer`);
    }
    // The graph stays useful: published source is found, task text is not.
    const found = (await f.mcp(f.observer, "room_map", { op: "query", q: "helper" })).value;
    assert.equal(found.found, true);
    assert.equal(found.repo, MAP_REPO);
    assert.ok(JSON.stringify(found).includes("a.js"));
    for (const q of [PRIVATE.TITLE, `${PRIVATE.PATH}.js`, "secret"]) {
      assert.notEqual((await f.mcp(f.producer, "room_map", { op: "query", q })).value.found, true, "a task field is not a graph node, even for a participant");
    }
    assert.equal(f.stored(), before, "room_map reads changed stored rows");
  });

  test(`${representation}: export is refused whole to every non-owner and complete for the owner`, async t => {
    const f = await privateWorkFixture(t, representation);
    const before = f.stored();
    const eventCount = () => f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id='commons'").get().n;
    const count = eventCount();
    for (const format of ["jsonl", "html"]) {
      for (const viewer of VIEWERS) {
        const refused = await raw(f, f[viewer], `/export?format=${format}`);
        const text = await refused.text();
        assert.equal(refused.status, 403, `${viewer} ${format}`);
        assert.match(refused.headers.get("content-type") ?? "", /application\/json/, "a refusal is an error body, not an export");
        assert.equal(refused.headers.get("content-disposition"), null);
        assert.deepEqual(privateMarkers(text), []);
        assert.ok(!text.includes(PUBLIC.TITLE) && !text.includes("work.proposed"), "a refusal carries no partial export");
      }
    }
    const invalid = await raw(f, ownerOf(f), "/export?format=csv");
    assert.equal(invalid.status, 422);
    assert.equal(f.stored(), before, "refused exports changed stored rows");
    assert.equal(eventCount(), count, "a refused export appends nothing");

    const jsonl = await raw(f, ownerOf(f), "/export"), jsonlText = await jsonl.text();
    assert.equal(jsonl.status, 200);
    assert.match(jsonl.headers.get("content-type"), /application\/x-ndjson/);
    assert.equal(Number(jsonl.headers.get("content-length")), Buffer.byteLength(jsonlText), "the whole export arrived");
    const lines = jsonlText.trimEnd().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.sequence), lines.map((_, index) => index + 1), "dense sequence");
    const html = await raw(f, ownerOf(f), "/export?format=html"), htmlText = await html.text();
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    // The owner proposed this task and is a party to its private request.
    for (const [format, text] of [["jsonl", jsonlText], ["html", htmlText]]) {
      for (const marker of [PRIVATE.TITLE, PRIVATE.REQUEST, PRIVATE.BLOCKER, PRIVATE.HANDOFF, PRIVATE.OLDSUMMARY, PRIVATE.SUMMARY, PRIVATE.REVIEW]) {
        assert.ok(text.includes(marker), `owner ${format} export holds ${marker}`);
      }
      for (const marker of [PUBLIC.TITLE, PUBLIC.RESULT]) assert.ok(text.includes(marker), `owner ${format} export holds public ${marker}`);
    }
    assert.ok(lines.some(line => line.event.type === "work.proposed" && line.event.data.workItemId === "secret" && line.event.data.title === PRIVATE.TITLE));
    // An export is audited, and that is all it writes.
    const added = f.store.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence").all().slice(count).map(row => JSON.parse(row.body).type);
    assert.deepEqual([...new Set(added)], ["room.exported"]);
    assert.equal(added.length, 2);
    const after = JSON.parse(f.stored()), was = JSON.parse(before);
    assert.deepEqual(after.events.slice(0, was.events.length), was.events, "earlier events are untouched");
    assert.deepEqual([after.item, after.open, after.board], [was.item, was.open, was.board], "work and Board rows are untouched");
  });

  test(`${representation}: export withholds private work from an owner outside the task`, async t => {
    const f = await privateWorkFixture(t, representation);
    // A private task the owner neither proposed nor was asked about.
    const mark = name => `zq-private-ownerless${name}-zq`;
    f.send(f.broad.key, "work.proposed", { workItemId: "theirs", title: mark("title"), definitionOfDone: mark("done"), accountableMemberId: f.producer.id, mode: "write" });
    f.store.dmConsents.request("commons", f.broad.id, f.producer.id, "fixture");
    f.store.dmConsents.decide("commons", f.producer.id, f.broad.id, "approve");
    f.send(f.broad.key, "message.posted", { messageId: "theirs-ask", toMemberId: f.producer.id, workItemId: "theirs", requestKind: "reply", body: mark("ask") });
    f.send(f.producer.key, "work.accepted", { workItemId: "theirs", expectedRevision: f.rev("theirs") });
    f.send(f.producer.key, "claim.acquired", { workItemId: "theirs", expectedRevision: f.rev("theirs"), repository: `acme/${mark("repo")}`, ref: "main", paths: [`${mark("path")}.js`],
      expiresAt: new Date(Date.now() + 3600000).toISOString() });
    const theirs = text => privateMarkers(text).filter(marker => marker.includes("ownerless"));
    // Settled on both stores: the owner's live reads withhold it, and a direct
    // message the owner is not a party to never reaches the export.
    assert.equal((await (await raw(f, ownerOf(f), "")).json()).state.workItems.theirs.title, null);
    assert.deepEqual(theirs(await (await raw(f, ownerOf(f), "/events?after=0&limit=100")).text()), []);
    for (const format of ["jsonl", "html"]) {
      const response = await raw(f, ownerOf(f), `/export?format=${format}`), text = await response.text();
      assert.equal(response.status, 200);
      assert.ok(!text.includes(mark("ask")), "a direct message between other members is not exported");
      assert.ok(text.includes(PUBLIC.TITLE));
      assert.deepEqual(theirs(text), [], "ownership does not grant private-task access");
    }
  });
}
