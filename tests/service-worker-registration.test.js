// R-25: push-sw.js registers on ordinary app load, not only inside the
// push-subscribe flow. Before this, the sole registration lived in
// subscribe() in src/human-push.js, so a visitor who never entered the
// push flow (e.g. macOS Safari / Add to Dock) got no service worker, no
// offline shell, and no worker-managed upgrade path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const entry = readFileSync(new URL("../src/entry.js", import.meta.url), "utf8");
const humanPush = readFileSync(new URL("../src/human-push.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const REGISTER = /navigator\.serviceWorker\.register\(worker\.href, \{ scope: new URL\("\.\/", worker\)\.pathname \}\)/;

test("the entry module loaded on every app load registers push-sw.js", () => {
  assert.match(html, /<script id="entry-module" type="module" src="\.\/src\/entry\.js"><\/script>/);
  assert.match(entry, REGISTER, "entry.js must register the worker on load");
  assert.match(entry, /new URL\("\.\.\/push-sw\.js", import\.meta\.url\)/);
  // Registration is guarded so browsers without service workers still load.
  assert.match(entry, /if \("serviceWorker" in navigator && !navigator\.webdriver\) \{[\s\S]*navigator\.serviceWorker\.register/);
});

test("automated browsers skip the on-load worker so page.route() keeps seeing every request", () => {
  // The guard is the only thing between a fetch-handling worker and the
  // Playwright route interception the browser checks rely on (main went red
  // for a week when R-25 registered the worker unconditionally).
  const guard = entry.indexOf('!navigator.webdriver');
  const register = entry.indexOf("navigator.serviceWorker.register(");
  assert.ok(guard > 0 && register > guard, "the webdriver guard must precede the registration");
  assert.equal(entry.match(/navigator\.serviceWorker\.register\(/g)?.length, 1);
});

test("on-load registration uses the same script and scope as subscribe(), so it cannot register twice", () => {
  assert.match(humanPush, REGISTER, "subscribe() keeps its original registration call");
  // Same worker URL construction in both call sites: the browser returns
  // the existing registration for a repeat register() of the same
  // script URL + scope instead of installing a second worker.
  const workerConstruction = /new URL\("\.\.\/push-sw\.js", import\.meta\.url\)/g;
  assert.equal(entry.match(workerConstruction)?.length, 1);
  assert.equal(humanPush.match(workerConstruction)?.length, 1);
});

test("on-load registration never prompts and never subscribes: subscription stays in the gesture flow", () => {
  assert.doesNotMatch(entry, /requestPermission/, "app load must not prompt for notification permission");
  assert.doesNotMatch(entry, /pushManager/, "app load must not touch push subscription");
  assert.doesNotMatch(entry, /Notification/, "app load must not touch the Notification API");
  // The only pushManager.subscribe in the client stays inside human-push.js,
  // reached via refresh() after a granted permission or the button click.
  assert.match(humanPush, /registration\.pushManager\.subscribe\(/);
  assert.match(humanPush, /button\.addEventListener\("click"/);
});
