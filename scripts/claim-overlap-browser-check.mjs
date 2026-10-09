// Claim overlaps on the work card: when a claim covers paths another active
// claim in the same repository already holds, the card's scope summary says
// "Overlaps 1" and the details name the other work, its holder and the paths.
// Real browser + local HTTP service; disposable fixture data.
import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./browser-harness.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";

test("a claim on already-claimed paths shows who else holds them", { timeout: 60000 }, async t => {
  const f = await boot(t, { streamInterval: 40 }), { page, errors, origin } = f;
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  const revision = id => f.store.snapshot(f.keys.owner, "commons").state.workItems[id].revision;
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  for (const [id, title, paths] of [["w-first", "Fix login redirect", ["src/app.js", "server/**"]], ["w-second", "Start a room", ["./src/app.js", "deploy/room-entry.mjs"]]]) {
    send(T.WORK_PROPOSED, { workItemId: id, title, definitionOfDone: "Evidence returned", accountableMemberId: "owner", mode: "write", independentVerificationRequired: false, ownerDecisionRequired: false });
    send(T.WORK_ACCEPTED, { workItemId: id, expectedRevision: revision(id) });
    send(T.CLAIM_ACQUIRED, { workItemId: id, expectedRevision: revision(id), repository: "Uuriko/project-room", ref: id, paths, expiresAt });
  }
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });

  const first = page.locator('[data-work-record-id="w-first"]'), second = page.locator('[data-work-record-id="w-second"]');
  await second.waitFor();
  const openDetails = async card => { if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click(); };
  await openDetails(second);
  assert.match(await second.locator(".claim > summary").innerText(), /Overlaps 1/);
  await second.locator(".claim > summary").click();
  assert.match(await second.locator(".claim-overlap-list").innerText(), /Fix login redirect.*src\/app\.js/s);
  await openDetails(first);
  assert.doesNotMatch(await first.locator(".claim > summary").innerText(), /Overlaps/, "the earlier claim is not rewritten");
  assert.deepEqual(errors, []);
});
