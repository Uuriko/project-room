// macOS wake bridge contract (CX4B-WAKE): the native shell signals system
// wake by evaluating one JavaScript snippet in the already-loaded room page.
// Both web recovery handlers — the session-restore lifecycle and the presence
// refresh in src/app.js — run only for a *persisted* pageshow, the platform's
// "already-loaded page shown again" signal. A bare Event('pageshow') carries
// persisted=false and is ignored by both, which is why wake recovery never
// fired from the macOS app. These tests pin the two sides of the contract to
// each other: the bridge must send the deliberate persisted signal, and the
// handlers must keep their persisted gate for ordinary page loads.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const swift = readFileSync(join(ROOT, "desktop/macos/Sources/ProjectRoomKit/RoomWindow.swift"), "utf8");
const app = readFileSync(join(ROOT, "src/app.js"), "utf8");

const WAKE_SIGNAL = "window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))";

function wakeObserverBlock(source) {
  const start = source.indexOf("NSWorkspace.didWakeNotification");
  assert.ok(start !== -1, "the wake observer is registered for didWakeNotification");
  const end = source.indexOf("open(url)", start);
  assert.ok(end > start, "the wake observer block terminates at the initial open");
  return source.slice(start, end);
}

test("macOS wake observer dispatches the persisted pageshow signal", () => {
  const block = wakeObserverBlock(swift);
  assert.ok(block.includes(`evaluateJavaScript("${WAKE_SIGNAL}"`),
    "the wake observer evaluates the persisted PageTransitionEvent dispatch");
  assert.ok(block.includes("RoomLocation.sameOrigin"),
    "the wake signal stays fenced to the room origin");
});

test("the bridge never dispatches a bare pageshow event", () => {
  assert.ok(!swift.includes("new Event('pageshow')"),
    "a bare Event('pageshow') has persisted=false and both recovery handlers ignore it");
  const dispatches = swift.match(/dispatchEvent\(new PageTransitionEvent\('pageshow', \{ persisted: true \}\)\)/g) ?? [];
  assert.equal(dispatches.length, 1, "exactly one wake signal definition exists in the bridge");
});

test("the web restore lifecycle keeps its persisted gate", () => {
  const handler = app.indexOf('window.addEventListener("pageshow", e => {');
  assert.ok(handler !== -1, "the restore pageshow handler exists");
  const gate = app.indexOf("if (!e.persisted) return;", handler);
  assert.ok(gate > handler, "the restore handler still returns early for non-persisted pageshow");
  const restore = app.indexOf("client.restore()", gate);
  assert.ok(restore > gate, "the gated handler drives the existing client.restore() lifecycle");
});

test("the wake handler treats a superseded restore as cancellation, never as wrong-room", () => {
  // Codex review P1 (PR #3476): restore() returns null when a newer
  // lifecycle supersedes it (client generation guard). The handler must
  // return on that sentinel before any teardown, and the account
  // continuation must be fenced to the wake that initiated it.
  const handler = app.indexOf('window.addEventListener("pageshow", e => {');
  assert.ok(handler !== -1, "the restore pageshow handler exists");
  const probe = app.indexOf("const joined = await client.restore();", handler);
  assert.ok(probe > handler, "the handler probes the room-cookie session");
  const sentinel = app.indexOf("if (joined === null) return null;", probe);
  assert.ok(sentinel > probe, "a superseded (null) restore returns before any teardown");
  const mismatch = app.indexOf("client.endAccess();", probe);
  assert.ok(mismatch > sentinel, "the wrong-room teardown sits after the supersession sentinel");
  const fence = app.indexOf("const probeGeneration = client.generation;", sentinel);
  const accountProbe = app.indexOf("const account = await ensureAccountSession();", fence);
  assert.ok(accountProbe > fence, "the account continuation is fenced to this wake's generation");
  const destinationFence = app.indexOf("selectedRoomFromLocation() !== roomId", fence);
  assert.ok(destinationFence > fence && destinationFence < accountProbe + 200,
    "the account continuation also re-checks the selected destination");
});

test("the web presence refresh keeps its persisted + visible gate", () => {
  const handler = app.indexOf('window.addEventListener("pageshow", event => {');
  assert.ok(handler !== -1, "the presence pageshow handler exists");
  const gate = app.indexOf("event.persisted && document.visibilityState === \"visible\"", handler);
  assert.ok(gate > handler, "the presence handler still requires persisted + visible");
  const refresh = app.indexOf("refreshPresenceStates()", gate);
  assert.ok(refresh > gate, "the gated handler refreshes presence states");
});
