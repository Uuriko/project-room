// Simulated human journeys against disposable first-party data, not human research.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { boot } from "./browser-harness.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";

async function setup(t) {
  const f = await boot(t, { streamInterval: 40 }), { page, origin } = f;
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  return { ...f, page, errors: f.errors, send };
}

test("attempt ledger: a work card shows attributable attempts with environment and outcome", { timeout: 60000 }, async t => {
  const f = await setup(t), { page, send } = f;
  send(T.WORK_PROPOSED, { workItemId: "attempted-work", title: "Port the digest job", definitionOfDone: "Digest runs green in CI.", accountableMemberId: "owner", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false });
  const revision = () => f.store.snapshot(f.keys.owner, "commons").state.workItems["attempted-work"].revision;
  send(T.SESSION_STARTED, { workItemId: "attempted-work", expectedRevision: revision(), environment: "ci-runner-2" });
  send(T.SESSION_STOPPED, { workItemId: "attempted-work", expectedRevision: revision(), status: "failed", outputs: ["log:run-1"] });
  send(T.SESSION_STARTED, { workItemId: "attempted-work", expectedRevision: revision(), environment: "local-mac-1" });
  const card = page.locator('[data-work-record-id="attempted-work"]');
  await card.waitFor();
  if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
  const ledger = card.locator("[data-attempt-ledger]");
  await ledger.waitFor();
  const text = await ledger.textContent();
  assert.match(text, /#1 .+ · failed · ci-runner-2/);
  assert.match(text, /#2 .+ · running · local-mac-1/);
  // An untouched card renders no ledger line.
  const plain = page.locator('[data-work-record-id="test-handoff"]');
  if (!await plain.locator(".work-details").evaluate(node => node.open)) await plain.locator(".work-details > summary").click();
  assert.equal(await plain.locator("[data-attempt-ledger]").count(), 0);
  mkdirSync("test-results", { recursive: true });
  await card.screenshot({ path: "test-results/attempts-card.png" });
  assert.deepEqual(f.errors, []);
});
