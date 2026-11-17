// The return brief ("catch up") replays history since the reader's marker and
// lists current work. Both halves must withhold private work from a member
// outside it, without losing the reader's place: every scanned event stays in
// its page, so the continuation and the final horizon are the same for an
// outsider as they were before the payload was withheld.
import test from "node:test";
import assert from "node:assert/strict";
import { privateWorkFixture, privateMarkers, PRIVATE, PUBLIC } from "./helpers/private-work-fixture.mjs";

// Walk the whole brief in small pages, following the server's continuation.
async function walk(f, who, limit = 7) {
  const first = await f.rest(who, `/return-brief?limit=${limit}`);
  assert.equal(first.status, 200);
  const pages = [first.json], text = [first.text];
  for (let page = first.json; page.history.hasMore && pages.length < 100;) {
    const { horizon, after, cursor } = page.history.continuation;
    const next = await f.rest(who, `/return-brief?limit=${limit}&horizon=${horizon}&after=${after}&cursor=${cursor}`);
    assert.equal(next.status, 200);
    assert.ok(next.json.history.items.length === 0 || next.json.history.items[0].sequence > after, "pages move forward");
    page = next.json; pages.push(page); text.push(next.text);
  }
  const items = pages.flatMap(page => page.history.items);
  return { pages, items, text: text.join("\n"), through: pages.at(-1).history.evaluatedThrough, done: pages.at(-1).history.hasMore === false };
}
const aboutSecret = row => !row.event.type.startsWith("message.") && (row.event.data?.workItemId ?? row.event.data?.workClaim) === "secret";

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`${representation}: the return brief withholds private work from members outside it and keeps their place`, async t => {
    const f = await privateWorkFixture(t, representation);
    const before = f.stored();
    for (const viewer of ["observer", "triage", "broad"]) {
      const brief = await walk(f, f[viewer]);
      assert.deepEqual(privateMarkers(brief.text).map(marker => marker.slice(11, -3)), [], `${viewer} reads no private work content`);
      assert.ok(brief.done, "the walk reaches the end");
      assert.equal(brief.through, brief.pages[0].history.evaluatedThrough, "the horizon stays frozen");
      // The private work's steps are still in the history, marked withheld.
      const steps = brief.items.filter(aboutSecret);
      assert.ok(steps.length >= 10, `${viewer} still sees that the work moved`);
      assert.ok(steps.every(row => row.event.data.withheld === true));
      // Public content is intact: the public task and the public result message.
      assert.ok(brief.text.includes(PUBLIC.TITLE), "public work keeps its title");
      assert.ok(brief.text.includes(PUBLIC.RESULT), "a result message posted to the room stays readable");
    }
    // Participants and the named reviewer keep the content.
    for (const viewer of ["producer", "reviewer"]) {
      const brief = await walk(f, f[viewer]);
      for (const marker of [PRIVATE.TITLE, PRIVATE.BLOCKER, PRIVATE.HANDOFF, PRIVATE.OLDSUMMARY, PRIVATE.REVIEW]) assert.ok(brief.text.includes(marker), `${viewer} reads ${marker}`);
      assert.ok(brief.items.filter(aboutSecret).every(row => row.event.data.withheld !== true));
    }
    // Same history positions for an outsider and a reviewer who authored little of it.
    const outside = await walk(f, f.observer), inside = await walk(f, f.reviewer);
    assert.equal(outside.through, inside.through);
    const positions = brief => brief.items.filter(aboutSecret).map(row => [row.sequence, row.event.id, row.event.type]);
    assert.deepEqual(positions(outside), positions(inside).filter(([sequence]) => sequence > outside.pages[0].history.cursor), "each work step keeps its sequence, id and type");
    assert.equal(f.stored(), before, "reads changed stored rows");
  });
}
