import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
  onboardMain,
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

test("corrupt state file fails with the file path and a recovery hint", t => {
  const dir = mkdtempSync(join(tmpdir(), "onboard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "bad.json");
  writeFileSync(path, "{broken json");
  assert.throws(() => loadState(path), err => {
    assert.match(err.message, /corrupt/);
    assert.match(err.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(err.message, /Move it aside or delete it/);
    return true;
  });
});

test("structurally invalid state fails with a recovery hint", t => {
  const dir = mkdtempSync(join(tmpdir(), "onboard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const notObject = join(dir, "arr.json");
  writeFileSync(notObject, "[1,2]");
  assert.throws(() => loadState(notObject), /corrupt/);
  const noOnboardings = join(dir, "nobj.json");
  writeFileSync(noOnboardings, JSON.stringify({ version: 1 }));
  assert.throws(() => loadState(noOnboardings), /corrupt/);
  const badVersion = join(dir, "ver.json");
  writeFileSync(badVersion, JSON.stringify({ version: 999, onboardings: {} }));
  assert.throws(() => loadState(badVersion), /unsupported onboarding state version 999/);
});

test("operations on unknown identities name the fix", t => {
  const { state } = fresh(t);
  assert.throws(() => assignCoach(state, "ai_ghost", "Coda"), /no onboarding for ai_ghost.*start ai_ghost/);
  assert.throws(() => completeItem(state, "ai_ghost", "role", "r"), /no onboarding for ai_ghost/);
  assert.throws(() => checklistView(state, "ai_ghost"), /no onboarding for ai_ghost/);
  assert.throws(() => renderIntro(state, "ai_ghost"), /no onboarding for ai_ghost/);
});

test("intro gating names exactly the missing items", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID, "Growth");
  assert.throws(() => renderIntro(state, ID), /complete lane-tag, role, update-format first/);
  completeItem(state, ID, "lane-tag", "[Growth]");
  assert.throws(() => renderIntro(state, ID), /complete role, update-format first/);
});

test("coach can be reassigned", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID);
  assignCoach(state, ID, "Coda");
  assignCoach(state, ID, "Instinct");
  assert.equal(state.onboardings[ID].coach, "Instinct");
});

test("whitespace-only values are rejected", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID);
  assert.throws(() => completeItem(state, ID, "role", "   "), /needs a value/);
});

test("first-contribution completes like any other item", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID, "Growth");
  completeItem(state, ID, "first-contribution", "claimed and shipped docs fix");
  const view = checklistView(state, ID);
  assert.equal(view.done, 2);
  assert.ok(view.items.find(i => i.id === "first-contribution").done);
});

async function runCli(t, argv, envPath) {
  const prevEnv = process.env.ROOM_ONBOARD_STATE;
  const prevLog = console.log;
  const prevErr = console.error;
  process.env.ROOM_ONBOARD_STATE = envPath;
  let out = "";
  console.log = s => { out += s + "\n"; };
  console.error = () => {};
  try {
    await onboardMain(argv);
  } finally {
    process.env.ROOM_ONBOARD_STATE = prevEnv;
    console.log = prevLog;
    console.error = prevErr;
  }
  return out;
}

test("--dry-run previews start without writing the state file", async t => {
  const dir = mkdtempSync(join(tmpdir(), "onboard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  const out = await runCli(t, ["start", "ai_dry", "--name", "Dry", "--dry-run"], path);
  const parsed = JSON.parse(out);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.started, "ai_dry");
  assert.ok(!existsSync(path), "dry-run must not create the state file");
});

test("--dry-run check does not persist item completion", async t => {
  const dir = mkdtempSync(join(tmpdir(), "onboard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  await runCli(t, ["start", "ai_dry2"], path);
  const out = await runCli(t, ["check", "ai_dry2", "role", "--value", "r", "--dry-run"], path);
  assert.equal(JSON.parse(out).dryRun, true);
  const reloaded = loadState(path);
  assert.equal(reloaded.onboardings["ai_dry2"].items.role.done, false, "dry-run check must not persist");
});

test("--dry-run on read-only commands warns instead of failing", async t => {
  const dir = mkdtempSync(join(tmpdir(), "onboard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  const out = await runCli(t, ["status", "--dry-run"], path);
  assert.deepEqual(JSON.parse(out), { onboardings: [] });
});

test("--dry-run intro previews the render without marking it done", async t => {
  const dir = mkdtempSync(join(tmpdir(), "onboard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  await runCli(t, ["start", "ai_dry3", "--name", "Dry3"], path);
  await runCli(t, ["check", "ai_dry3", "lane-tag", "--value", "[D]"], path);
  await runCli(t, ["check", "ai_dry3", "role", "--value", "r"], path);
  await runCli(t, ["check", "ai_dry3", "update-format", "--value", "u"], path);
  const out = await runCli(t, ["intro", "ai_dry3", "--dry-run"], path);
  const parsed = JSON.parse(out);
  assert.equal(parsed.dryRun, true);
  assert.match(parsed.text, /Dry3/);
  const reloaded = loadState(path);
  assert.equal(reloaded.onboardings["ai_dry3"].items.intro.done, false, "dry-run intro must not persist");
});

test("intro without a voice item uses the finding-it fallback", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID, "Growth");
  completeItem(state, ID, "lane-tag", "[Growth]");
  completeItem(state, ID, "role", "r");
  completeItem(state, ID, "update-format", "u");
  const out = renderIntro(state, ID);
  assert.match(out.text, /still finding it/);
});

test("checklist hides hints for completed items", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID, "Growth");
  const view = checklistView(state, ID);
  const name = view.items.find(i => i.id === "name");
  assert.equal(name.done, true);
  assert.equal(name.hint, undefined);
});

test("values are stored as strings", t => {
  const { state } = fresh(t);
  startOnboarding(state, ID);
  completeItem(state, ID, "role", 42);
  assert.equal(state.onboardings[ID].items.role.value, "42");
});
