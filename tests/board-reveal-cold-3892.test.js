// #3892 cure specimens: on a cold deep link or reload the board reveal check
// must run. The board module loads lazily, and the navigation hooks used to
// be assigned only inside its install() — so revealClaimRecord's first await
// on a cold entry found no hooks and returned early, and the deep-linked
// record was never disclosed (the warm path, board already installed, was
// the only one that worked). The hooks are now wired before the module
// loads and delegate through the lazy disclosure's ready(), which awaits
// the pending install instead of returning early. The wait is bounded by
// that single install flight: ready() never starts a retry loop, and the
// flight's settlement — success, failure, or supersession by reset — ends
// the wait, with a null view leaving the caller its honest refusal.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

// lazyDisclosure is app.js-internal; extract its source and evaluate it so
// the specimens drive the real function, not a copy.
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is present in src/app.js`);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${signature}`);
}
const lazyDisclosure = new Function(`${extractFunction(app, "function lazyDisclosure(")}\nreturn lazyDisclosure;`)();

function fakePanel() {
  const listeners = {};
  return {
    open: false, parentElement: null,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); }
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function fakeController() {
  return {
    revealed: [],
    sync() {},
    reset() {},
    async whenReady() { return true; },
    async revealClaim(id) { this.revealed.push(id); return true; }
  };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function coldBoard() {
  const panel = fakePanel();
  const gate = deferred();
  const controller = fakeController();
  const errors = [];
  let installs = 0;
  const board = lazyDisclosure({
    panel,
    load: () => gate.promise,
    install: () => { installs++; return controller; },
    onError: error => errors.push(error)
  });
  return { panel, gate, controller, errors, board, installs: () => installs };
}

test("cold deep link: ready() awaits the pending install, then the reveal runs", async () => {
  const { panel, gate, controller, board, installs } = coldBoard();
  panel.open = true; // openBoard: dialog shown, panel opened
  void board.sync(); // openBoard starts the lazy load
  let settled = false;
  const readyPromise = board.ready().then(view => { settled = true; return view; });
  await flush();
  assert.equal(settled, false, "ready() waits for the install instead of returning early");
  assert.equal(installs(), 0);
  gate.resolve({});
  const view = await readyPromise;
  assert.equal(view, controller, "ready() resolves the installed controller");
  assert.equal(installs(), 1);
  assert.equal(await view.revealClaim("claim-cold"), true);
  assert.deepEqual(controller.revealed, ["claim-cold"]);
});

test("cold entry: ready() starts the install when none is in flight yet", async () => {
  const { panel, gate, controller, board } = coldBoard();
  panel.open = true;
  const readyPromise = board.ready();
  gate.resolve({});
  assert.equal(await readyPromise, controller);
});

test("reload: a fresh page load reveals the same way", async () => {
  const { panel, gate, controller, board } = coldBoard();
  panel.open = true;
  void board.sync();
  const readyPromise = board.ready();
  gate.resolve({});
  const view = await readyPromise;
  assert.equal(view, controller);
  assert.equal(await view.revealClaim("claim-reload"), true);
  assert.deepEqual(controller.revealed, ["claim-reload"]);
});

test("warm path: ready() resolves the installed controller, no second install", async () => {
  const { panel, gate, controller, board, installs } = coldBoard();
  panel.open = true;
  void board.sync();
  gate.resolve({});
  await flush();
  await flush();
  assert.equal(installs(), 1);
  assert.equal(await board.ready(), controller);
  assert.equal(installs(), 1, "no double install on the warm path");
});

test("failed install: ready() resolves null (the caller's honest refusal), never hangs", async () => {
  const { panel, gate, errors, board } = coldBoard();
  panel.open = true;
  void board.sync();
  const readyPromise = board.ready();
  gate.reject(new Error("module failed"));
  assert.equal(await readyPromise, null);
  assert.equal(errors.length, 1, "the load error is reported once, by sync()");
});

test("reset during install: ready() resolves null instead of a stale controller", async () => {
  const { panel, gate, board, installs } = coldBoard();
  panel.open = true;
  void board.sync();
  const readyPromise = board.ready();
  board.reset();
  gate.resolve({});
  assert.equal(await readyPromise, null);
  assert.equal(installs(), 0, "a superseded install never lands");
});

function installBody() {
  const marker = "install: module => {";
  const start = app.indexOf(marker);
  assert.ok(start >= 0, "the board install callback exists");
  const open = app.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === "{") depth++;
    else if (app[i] === "}" && --depth === 0) return app.slice(open, i + 1);
  }
  throw new Error("unbalanced install body");
}

test("the navigation hooks are not assigned inside the board install()", () => {
  const body = installBody();
  assert.ok(!body.includes("navigationBoardReady ="), "navigationBoardReady is wired before the module loads");
  assert.ok(!body.includes("navigationBoardRevealClaim ="), "navigationBoardRevealClaim is wired before the module loads");
});

test("both navigation hooks delegate through board.ready()", () => {
  for (const hook of ["navigationBoardReady", "navigationBoardRevealClaim"]) {
    const at = app.indexOf(`${hook} = async`);
    assert.ok(at >= 0, `${hook} has a pre-load assignment`);
    assert.match(app.slice(at, at + 240), /board\.ready\(\)/, `${hook} awaits board.ready()`);
  }
});
