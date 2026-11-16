// A member outside a private task must not recover its content by choosing a
// different read. Every surface below is read over HTTP or MCP against a real
// store, for both storage representations, by three outsiders: an ordinary
// member, the handoff's triage addressee, and a member with broad permissions.
// Positive controls keep "hide everything" from passing: the private-request
// party and the named reviewer still read the content, public work keeps its
// title, and a result message posted to the room stays readable.
import test from "node:test";
import assert from "node:assert/strict";
import { privateWorkFixture, privateMarkers, PRIVATE, PUBLIC } from "./helpers/private-work-fixture.mjs";

const rest = path => (f, who) => f.rest(who, path).then(r => ({ ok: r.status === 200, text: r.text, json: r.json }));
const mcp = (name, args, profile) => (f, who) => f.mcp(who, name, args, profile).then(r => ({ ok: r.ok, text: r.text, json: r.value }));
// [label, read, storage it exists on, lists the public task's title]
const SURFACES = [
  ["GET room (default window)", rest(""), "both", true],
  ["GET room?view=work", rest("?view=work"), "both", true],
  ["GET room?view=orientation", rest("?view=orientation"), "both", true],
  ["GET /state", rest("/state"), "both", false],
  ["GET /events", rest("/events?after=0&limit=100"), "both", true],
  ["GET /presence", rest("/presence"), "both", false],
  ["GET /activation-pack", rest("/activation-pack"), "both", true],
  ["GET /activation-pack?view=brief", rest("/activation-pack?view=brief"), "both", false],
  ["GET /work-claims", rest("/work-claims"), "legacy", true],
  ["GET /work-claims/secret", rest("/work-claims/secret"), "legacy", false],
  ["room_activation_pack", mcp("room_activation_pack", {}, ""), "both", true],
  ["room_activation_pack brief", mcp("room_activation_pack", { view: "brief" }, ""), "both", false],
  ["room_list_work", mcp("room_list_work", {}, ""), "both", true],
  ["room_needs_me", mcp("room_needs_me", {}, ""), "both", false],
  ["room_project_state", mcp("room_project_state", {}, ""), "both", true],
  ["room_read_messages", mcp("room_read_messages", {}, ""), "both", false],
  ["get_room_context", mcp("get_room_context"), "both", false],
  ["room_digest", mcp("room_digest"), "both", false],
  ["room_read_board", mcp("room_read_board"), "both", true],
  ["room_list_events", mcp("room_list_events", { after: 0, limit: 100 }), "both", true],
  ["room_read_bootstrap", mcp("room_read_bootstrap"), "both", false],
  ["room_read_inbox", mcp("room_read_inbox"), "both", false],
  ["room_work_claim_thread", mcp("room_work_claim_thread", { claimId: "secret" }), "legacy", false],
  ["room_work_claim_provenance", mcp("room_work_claim_provenance", { claimId: "secret" }), "legacy", false]
];

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`${representation}: no supported read gives an outsider private work content`, async t => {
    const f = await privateWorkFixture(t, representation);
    const before = f.stored();
    const leaks = [], unavailable = [], hidden = [];
    for (const [label, read, storage, listsPublic] of SURFACES) {
      if (storage !== "both" && storage !== representation) continue;
      for (const viewer of ["observer", "triage", "broad"]) {
        const response = await read(f, f[viewer]);
        if (!response.ok) { unavailable.push(`${label} as ${viewer}`); continue; }
        const found = privateMarkers(response.text);
        if (found.length) leaks.push(`${label} as ${viewer}: ${found.map(m => m.slice(11, -3)).join(",")}`);
        if (listsPublic && viewer === "observer" && !response.text.includes(PUBLIC.TITLE)) hidden.push(label);
      }
    }
    assert.deepEqual(leaks, [], "private work content reached a member outside the task");
    assert.deepEqual(hidden, [], "public work lost its title");
    // A refused or unsupported read proves nothing; name any so the matrix is honest.
    t.diagnostic(`unavailable: ${JSON.stringify(unavailable)}`);
    assert.equal(f.stored(), before, "reads changed stored events, work or board rows");
  });

  test(`${representation}: participants and the named reviewer keep the content; public content stays public`, async t => {
    const f = await privateWorkFixture(t, representation);
    const P = PRIVATE;
    for (const viewer of ["producer", "reviewer"]) {
      const window = await f.rest(f[viewer], "");
      const item = window.json.state.workItems.secret;
      assert.equal(item.title, P.TITLE, `${viewer} reads the title`);
      assert.equal(item.claim.repository, `acme/${P.REPO}`, `${viewer} reads the claim scope`);
      // The normalized window carries a summary record; the selected read has the rest.
      const context = await f.mcp(f[viewer], "room_read_work", { workItemId: "secret" }, "");
      assert.ok(context.ok, `${viewer} still opens the task`);
      for (const marker of [P.SUMMARY, P.REVIEW]) assert.ok(context.text.includes(marker), `${viewer} reads ${marker} from the selected task`);
      const events = (await f.rest(f[viewer], "/events?after=0&limit=100")).text;
      for (const marker of [P.BLOCKER, P.HANDOFF, P.OLDSUMMARY, P.OLDREVIEW, P.REVIEW]) assert.ok(events.includes(marker), `${viewer} reads ${marker} in the event feed`);
    }
    // The reviewer can still do the review: the exact result is readable.
    const result = await f.mcp(f.reviewer, "room_read_result", { workItemId: "secret" }, "");
    assert.ok(result.ok && result.text.includes(PUBLIC.RESULT), "named reviewer reads the exact result");
    // A result message posted to the room is public; the outsider still reads it.
    const messages = await f.mcp(f.observer, "room_read_messages", {}, "");
    assert.ok(messages.ok && messages.text.includes(PUBLIC.RESULT), "public result message stays readable");
    // The outsider's record is truthful about state and revision.
    const outside = (await f.rest(f.observer, "")).json.state.workItems.secret, stored = f.item("secret");
    assert.deepEqual([outside.id, outside.state, outside.revision, outside.accountableMemberId, outside.verifierMemberId, outside.claim?.holderId ?? null, outside.title],
      [stored.id, stored.state, stored.revision, stored.accountableMemberId, stored.verifierMemberId, stored.claim?.holderId ?? null, null]);
    for (const history of ["receiptHistory", "verificationHistory"]) assert.deepEqual(outside[history] ?? [], [], `${history} is withheld`);
  });

  test(`${representation}: the event feed keeps its cursor and count for an outsider`, async t => {
    const f = await privateWorkFixture(t, representation);
    const page = async (who, limit) => {
      const rows = []; let after = 0, pages = 0, last;
      do { last = (await f.rest(who, `/events?after=${after}&limit=${limit}`)).json; rows.push(...last.events); assert.ok(last.next >= after); after = last.next; pages += 1; } while (last.hasMore && pages < 200);
      return { rows, next: last.next, hasMore: last.hasMore };
    };
    const about = row => !row.event.type.startsWith("message.") && (row.event.data?.workItemId ?? row.event.data?.workClaim) === "secret";
    const inside = await page(f.producer, 5), outside = await page(f.observer, 5);
    assert.equal(outside.hasMore, false);
    assert.equal(outside.next, inside.next, "both readers finish at the same cursor");
    const mine = inside.rows.filter(about), theirs = outside.rows.filter(about);
    assert.ok(mine.length >= 12, "the fixture produced the work history");
    assert.deepEqual(theirs.map(row => [row.sequence, row.event.id, row.event.type, row.event.actorId]), mine.map(row => [row.sequence, row.event.id, row.event.type, row.event.actorId]),
      "every work event keeps its place, id, type and actor");
    assert.ok(theirs.every(row => row.event.data.withheld === true), "each is marked withheld");
    assert.deepEqual(privateMarkers(JSON.stringify(theirs)), []);
    // Events about public work are untouched.
    const open = row => !row.event.type.startsWith("message.") && row.event.data?.workItemId === "open";
    assert.deepEqual(outside.rows.filter(open), inside.rows.filter(open));
  });

  test(`${representation}: access follows current request parties, not a remembered answer`, async t => {
    const f = await privateWorkFixture(t, representation);
    assert.equal((await f.rest(f.observer, "")).json.state.workItems.secret.title, null);
    f.store.dmConsents.request("commons", "owner", f.observer.id, "fixture");
    f.store.dmConsents.decide("commons", f.observer.id, "owner", "approve");
    f.send(f.owner, "message.posted", { messageId: "second-ask", toMemberId: f.observer.id, workItemId: "secret", requestKind: "reply", body: "Please look" });
    assert.equal((await f.rest(f.observer, "")).json.state.workItems.secret.title, PRIVATE.TITLE, "a new request party reads the task on the next read");
    assert.equal((await f.rest(f.triage, "")).json.state.workItems.secret.title, null, "another outsider still does not");
  });
}
