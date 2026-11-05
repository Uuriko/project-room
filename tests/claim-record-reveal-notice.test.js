import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// #3892: behavioural harness over the real revealClaimRecord and its board
// installation waiter, lifted from src/app.js and run against stubs.
const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const slice = (start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, start);
  return source.slice(from, source.indexOf(end, from));
};
const waiterSource = slice("let navigationBoardWaiters = [];", "\n// ");
const revealSource = slice("async function revealClaimRecord(id)", "\nfunction navigateWorkRecord");

function harness() {
  const notices = [];
  const ctx = {
    notices, busy: false, workNavigationEpoch: 0, navigationBoardEpoch: 0, navContext: { room: "r1" },
    navigationBoardReady: null, navigationBoardRevealClaim: null, SOURCE_UNAVAILABLE_NOTICE: "unavailable",
    dialog: { open: false }, synced: 0,
  };
  vm.createContext(ctx);
  vm.runInContext(`
    var workNavigationContext = () => navContext;
    var notice = (text) => notices.push(text);
    var syncWorkReturnControl = () => { synced++; };
    var $ = (sel) => sel === "#board-dialog" ? dialog : { click() { dialog.open = true; } };
    ${waiterSource.replace("let navigationBoardWaiters", "var navigationBoardWaiters")}
    ${revealSource}
    this.install = (reveal) => { navigationBoardReady = async () => true; navigationBoardRevealClaim = reveal; settleNavigationBoardWaiters(true); };
    this.reveal = revealClaimRecord;
  `, ctx);
  return ctx;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("cold deep link waits for board installation, then reports a missing claim", async () => {
  const h = harness();
  const pending = h.reveal("missing");
  await tick();
  assert.deepEqual(h.notices, []);
  h.install(async () => false);
  await pending;
  assert.deepEqual(h.notices, ["unavailable"]);
});

test("cold deep link to an available claim reveals it with no notice", async () => {
  const h = harness();
  const seen = [];
  const pending = h.reveal("present");
  await tick();
  h.install(async id => { seen.push(id); return true; });
  await pending;
  assert.deepEqual(seen, ["present"]);
  assert.deepEqual(h.notices, []);
  assert.equal(h.synced, 1);
});

for (const [name, leave] of [
  ["board closed", h => { h.navigationBoardEpoch++; }],
  ["navigated back", h => { h.workNavigationEpoch++; }],
  ["room switched", h => { h.navContext = { room: "r2" }; }],
]) {
  test(`no stale notice when ${name} during the forced board read`, async () => {
    const h = harness();
    let release;
    h.install(() => new Promise(resolve => { release = resolve; }));
    const pending = h.reveal("missing");
    await tick(); await tick();
    assert.equal(typeof release, "function");
    leave(h);
    release(false);
    await pending;
    assert.deepEqual(h.notices, []);
    assert.equal(h.synced, 0);
  });
}

test("board load failure settles the waiter without a reveal", async () => {
  const h = harness();
  const pending = h.reveal("missing");
  vm.runInContext("settleNavigationBoardWaiters(false)", h);
  await pending;
  assert.deepEqual(h.notices, []);
});
