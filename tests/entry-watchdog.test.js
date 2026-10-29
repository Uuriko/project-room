// F-U1B2-1: the root door's only executable script is the module
// src/entry.js. If it (or a static import) fails to load, the module never
// evaluates, entry.js's own showLoadFailure() is unreachable, and the door
// used to wedge on "Connecting to room service…" forever. The classic
// src/entry-watchdog.js script mirrors the /join loader watchdog (#1608):
// after 15s with entryStarted still unset it swaps in the same
// load-failure surface entry.js uses. These tests pin the wiring against
// a real server and the watchdog logic in a vm DOM stub — the stub is not
// a browser module-load drop; the executed browser confirmation is a
// separate lane's evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-entry-watchdog-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin };
}

test("root door loader cannot stick forever: external watchdog ships the load-failure surface (F-U1B2-1)", async t => {
  const { origin } = await serve(t);
  for (const [pagePath, watchdogPath] of [["/", "/src/entry-watchdog.js"], ["/room/", "/room/src/entry-watchdog.js"]]) {
    const res = await fetch(`${origin}${pagePath}`);
    assert.equal(res.status, 200, `${pagePath} serves`);
    const html = await res.text();
    const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(match => match[1]);
    assert.ok(scripts.some(src => src.endsWith("/src/entry-watchdog.js")), `${pagePath} loads the watchdog`);
    const watchdogIndex = scripts.findIndex(src => src.includes("entry-watchdog.js"));
    const entryIndex = scripts.findIndex(src => /\/entry\.js$/.test(src));
    assert.ok(watchdogIndex !== -1 && entryIndex !== -1 && watchdogIndex < entryIndex,
      `${pagePath} loads the watchdog before the entry module`);
    const asset = await fetch(`${origin}${watchdogPath}`);
    assert.equal(asset.status, 200, `${watchdogPath} serves`);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/, `${watchdogPath} content type`);
    const watchdog = await asset.text();
    assert.match(watchdog, /entryStarted/, "watchdog keys on the entry-started flag");
    assert.match(watchdog, /The room could not load\. Reload to try again\./, "watchdog ships the entry.loadFailed copy");
    assert.match(watchdog, /15000/, "watchdog uses the 15s timeout class of the join watchdog");
  }
});

// Minimal DOM stub: just the surface the watchdog touches.
function stubDom({ started = false, hero = true } = {}) {
  const listeners = {};
  const elements = new Map();
  const make = (tag, id = "") => {
    const el = {
      tag, id, type: "", className: "", textContent: "", hidden: false, removed: false,
      classes: new Set(),
      classList: { add: (...names) => names.forEach(name => el.classes.add(name)) },
      remove() { el.removed = true; elements.delete(`#${el.id}`); },
      after(node) { el.afterNode = node; if (node.id) elements.set(`#${node.id}`, node); },
      addEventListener(name, fn) { listeners[`${el.id}:${name}`] = fn; },
    };
    if (id) elements.set(`#${id}`, el);
    return el;
  };
  const heroEl = hero ? make("section", "static-hero") : null;
  const statusEl = make("p", "auth-error");
  const panelEl = make("section", "auth-panel");
  panelEl.hidden = true;
  const document = {
    documentElement: { dataset: started ? { entryStarted: "true" } : {} },
    querySelector: selector => elements.get(selector) ?? null,
    createElement: tag => make(tag),
  };
  return { document, heroEl, statusEl, panelEl, listeners };
}

function runWatchdog(dom) {
  const source = readFileSync(fileURLToPath(new URL("../src/entry-watchdog.js", import.meta.url)), "utf8");
  let timer = null;
  const sandbox = {
    document: dom.document,
    location: { reload: () => { sandbox.reloaded = true; } },
    setTimeout: (fn, ms) => { timer = { fn, ms }; },
  };
  vm.runInNewContext(source, sandbox);
  assert.ok(timer, "watchdog arms a timer");
  assert.equal(timer.ms, 15000, "watchdog timeout is the join watchdog's 15s class");
  timer.fn();
  return sandbox;
}

test("watchdog fires the load-failure surface when entry never started", () => {
  const dom = stubDom();
  const sandbox = runWatchdog(dom);
  assert.equal(dom.heroEl.removed, true, "static hero removed, as showLoadFailure does");
  assert.equal(dom.statusEl.textContent, "The room could not load. Reload to try again.");
  assert.ok(dom.statusEl.classes.has("error") && dom.statusEl.classes.has("visible"), "error styling applied");
  assert.equal(dom.panelEl.hidden, false, "auth panel unhidden");
  const retry = dom.statusEl.afterNode;
  assert.ok(retry, "a retry control is inserted after the error");
  assert.equal(retry.id, "entry-retry");
  assert.equal(retry.textContent, "Reload");
  dom.listeners["entry-retry:click"]();
  assert.equal(sandbox.reloaded, true, "retry reloads the page");
});

test("watchdog stays silent when entry started (dynamic failures are entry.js's own path)", () => {
  const dom = stubDom({ started: true });
  runWatchdog(dom);
  assert.equal(dom.heroEl.removed, false);
  assert.equal(dom.statusEl.textContent, "");
  assert.equal(dom.panelEl.hidden, true);
  assert.equal(dom.statusEl.afterNode, undefined);
});

test("watchdog stays silent when the boot/failure surface already replaced the hero", () => {
  const dom = stubDom({ hero: false });
  runWatchdog(dom);
  assert.equal(dom.statusEl.textContent, "");
  assert.equal(dom.panelEl.hidden, true);
});
