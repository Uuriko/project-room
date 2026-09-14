import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKLIST,
  loadState,
  saveState,
  startOnboarding,
  assignCoach,
  completeItem,
  checklistView,
  renderIntro,
  statusView,
} from "../scripts/agent-onboard.mjs";

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), "onboard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "onboarding.json");
  return { path, state: loadState(path) };
}

const ID = "ai_test123";

test("start creates a pending checklist; seeding the name completes it", t => {
  const { state } = fresh(t);
  const ob = startOnboarding(state, ID, "Growth");
  assert.equal(ob.displayName, "Growth");
  assert.ok(ob.items.name.done);
  assert.equal(ob.items.name.value, "Growth");
  assert.equal(ob.coach, null);
  for (const item of CHECKLIST) assert.ok(ob.items[item.id], `item ${item.id} exists`);
  assert.throws(() => startOnboarding(state, ID), /already started/);
});

test("coach assignment requires a coach member id", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID);
  assert.throws(() => assignCoach(state, ID, ""), /coach member id is required/);
  assert.throws(() => assignCoach(state, "ai_missing", "Coda"), /no onboarding/);
  assignCoach(state, ID, "Coda");
  assert.equal(state.onboardings[ID].coach, "Coda");
});

test("check completes items with values and rejects bad input", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID);
  assert.throws(() => completeItem(state, ID, "nope", "x"), /unknown checklist item/);
  assert.throws(() => completeItem(state, ID, "role", ""), /needs a value/);
  assert.throws(() => completeItem(state, ID, "role"), /needs a value/);
  assert.throws(() => completeItem(state, ID, "intro", "x"), /not by hand/);
  completeItem(state, ID, "role", "researcher-operator for distribution");
  assert.ok(state.onboardings[ID].items.role.done);
  assert.equal(state.onboardings[ID].items.role.value, "researcher-operator for distribution");
  // name check keeps displayName in sync
  completeItem(state, ID, "name", "Growth");
  assert.equal(state.onboardings[ID].displayName, "Growth");
});

test("checklist view reports done/total with hints for the rest", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID, "Growth");
  const view = checklistView(state, ID);
  assert.equal(view.done, 1);
  assert.equal(view.total, CHECKLIST.length);
  const role = view.items.find(i => i.id === "role");
  assert.equal(role.done, false);
  assert.ok(role.hint, "pending items carry a coaching hint");
});

test("intro refuses until name, lane-tag, role, update-format are done", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID, "Growth");
  assert.throws(() => renderIntro(state, ID), /intro not ready/);
  completeItem(state, ID, "lane-tag", "[Growth]");
  completeItem(state, ID, "role", "researcher-operator for distribution");
  assert.throws(() => renderIntro(state, ID), /update-format/);
  completeItem(state, ID, "update-format", "headline first, then the evidence needed to act");
  const out = renderIntro(state, ID);
  assert.equal(out.channel, "#general");
  assert.match(out.text, /Growth/);
  assert.match(out.text, /\[Growth\]/);
  assert.match(out.text, /researcher-operator for distribution/);
  assert.match(out.text, /headline first/);
  assert.ok(state.onboardings[ID].items.intro.done, "rendering marks the intro item done");
});

test("intro credits the coach when one is assigned", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID, "Growth");
  assignCoach(state, ID, "Coda");
  completeItem(state, ID, "lane-tag", "[Growth]");
  completeItem(state, ID, "role", "r");
  completeItem(state, ID, "update-format", "u");
  const out = renderIntro(state, ID);
  assert.match(out.text, /Coda/);
  assert.match(out.text, /coaching stays private/);
});

test("status lists every onboarding with progress", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID, "Growth");
  startOnboarding(state, "ai_other");
  const rows = statusView(state);
  assert.equal(rows.length, 2);
  const mine = rows.find(r => r.identityId === ID);
  assert.equal(mine.done, 1);
  assert.equal(mine.total, CHECKLIST.length);
});

test("state round-trips through the JSON file", t => {
  const { path, state } = fresh(t);
  startOnboarding(state, ID, "Growth");
  assignCoach(state, ID, "Coda");
  completeItem(state, ID, "role", "r");
  saveState(state, path);
  const reloaded = loadState(path);
  assert.equal(reloaded.onboardings[ID].coach, "Coda");
  assert.ok(reloaded.onboardings[ID].items.role.done);
  // a missing file loads as empty state, not an error
  const empty = loadState(join(tmpdir(), "onboard-never-created.json"));
  assert.deepEqual(empty, { version: 1, onboardings: {} });
});
