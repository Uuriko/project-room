// LANE B: command palette registry + shortcut map tests (no DOM; stub target).
import test from "node:test";
import assert from "node:assert/strict";
import {
  TRIAGE_SHORTCUTS, DEFAULT_COMMANDS, createPalette, matchCommand,
  shortcutForEvent, isPaletteToggle, installPalette,
} from "../src/inbox-palette.js";

const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code);

// Minimal event-target stub (no DOM framework, no browser globals).
const makeTarget = () => {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter(f => f !== fn)),
    emit: event => { for (const fn of listeners.get("keydown") ?? []) fn(event); },
    listenerCount: type => (listeners.get(type) ?? []).length,
  };
};
const keyEvent = (key, over = {}) => ({ key, target: { tagName: "DIV" }, preventDefault: () => {}, ...over });

test("default commands and shortcuts are registered", () => {
  const palette = createPalette();
  assert.ok(palette.count() >= DEFAULT_COMMANDS.length);
  assert.equal(palette.command("triage.archive").title, "Archive thread");
  assert.equal(TRIAGE_SHORTCUTS["triage.archive"], "e");
  assert.ok(Object.isFrozen(TRIAGE_SHORTCUTS));
});

test("register / unregister / duplicate / unknown", () => {
  const palette = createPalette([]);
  palette.register({ id: "custom.ping", title: "Ping", run: () => "pong" });
  assert.equal(palette.run("custom.ping"), "pong");
  throwsCode(() => palette.register({ id: "custom.ping", title: "Dup" }), "PALETTE_DUPLICATE");
  throwsCode(() => palette.register({ id: "", title: "Bad" }), "PALETTE_INVALID_COMMAND");
  throwsCode(() => palette.register({ id: "x", title: "" }), "PALETTE_INVALID_COMMAND");
  assert.equal(palette.unregister("custom.ping"), true);
  throwsCode(() => palette.unregister("custom.ping"), "PALETTE_UNKNOWN_COMMAND");
  throwsCode(() => palette.run("custom.ping"), "PALETTE_UNKNOWN_COMMAND");
  palette.register({ id: "norun", title: "No runner" });
  throwsCode(() => palette.run("norun"), "PALETTE_NO_RUNNER");
});

test("matchCommand ranking: exact > prefix > word > substring", () => {
  const archive = { id: "triage.archive", title: "Archive thread" };
  const snooze = { id: "triage.snooze", title: "Snooze thread" };
  assert.ok(matchCommand(archive, "Archive thread") > matchCommand(archive, "arch"));
  assert.ok(matchCommand(archive, "arch") > matchCommand(archive, "thread"));
  assert.ok(matchCommand(archive, "thread") > matchCommand(archive, "hive"));
  assert.equal(matchCommand(snooze, "zzz"), -1);
  assert.equal(matchCommand(archive, ""), 1);
  assert.equal(matchCommand(archive, "  ARCH "), matchCommand(archive, "arch"));
});

test("search returns best matches first, frozen", () => {
  const palette = createPalette();
  const results = palette.search("thread");
  assert.ok(results.length > 1);
  assert.ok(Object.isFrozen(results));
  const archFirst = palette.search("arch");
  assert.equal(archFirst[0].id, "triage.archive"); // prefix beats substring hits
  const all = palette.search("");
  assert.equal(all.length, palette.count());
});

test("shortcutForEvent maps keys and ignores modifiers/editable targets", () => {
  assert.equal(shortcutForEvent(keyEvent("e")), "triage.archive");
  assert.equal(shortcutForEvent(keyEvent("Enter")), "triage.reply");
  assert.equal(shortcutForEvent(keyEvent("x")), null);
  assert.equal(shortcutForEvent(keyEvent("e", { metaKey: true })), null);
  assert.equal(shortcutForEvent(keyEvent("e", { ctrlKey: true })), null);
  assert.equal(shortcutForEvent(keyEvent("e", { target: { tagName: "TEXTAREA" } })), null);
  assert.equal(shortcutForEvent(keyEvent("e", { target: { tagName: "INPUT" } })), null);
  assert.equal(shortcutForEvent(keyEvent("e", { target: { isContentEditable: true } })), null);
  assert.equal(shortcutForEvent(null), null);
  assert.equal(shortcutForEvent(keyEvent("e"), { "custom.action": "e" }), "custom.action");
});

test("isPaletteToggle detects Cmd/Ctrl+K only", () => {
  assert.equal(isPaletteToggle(keyEvent("k", { metaKey: true })), true);
  assert.equal(isPaletteToggle(keyEvent("K", { ctrlKey: true })), true);
  assert.equal(isPaletteToggle(keyEvent("k")), false);
  assert.equal(isPaletteToggle(keyEvent("k", { metaKey: true, shiftKey: true })), false);
  assert.equal(isPaletteToggle(keyEvent("j", { metaKey: true })), false);
});

test("installPalette: cmd+k toggles, esc closes, shortcuts fire actions", () => {
  const target = makeTarget();
  const fired = [];
  const opened = [], closed = [];
  const installed = installPalette({
    target,
    commands: DEFAULT_COMMANDS.map(c => ({ ...c, run: () => fired.push(c.id) })),
    onCommand: action => fired.push(`onCommand:${action}`),
    onOpen: () => opened.push(true),
    onClose: () => closed.push(true),
  });
  assert.equal(installed.isOpen(), false);
  target.emit(keyEvent("k", { metaKey: true }));
  assert.equal(installed.isOpen(), true);
  assert.equal(opened.length, 1);
  // While open, single-key shortcuts are swallowed.
  target.emit(keyEvent("e"));
  assert.deepEqual(fired, []);
  target.emit(keyEvent("Escape"));
  assert.equal(installed.isOpen(), false);
  assert.equal(closed.length, 1);
  // Closed: single-key shortcut fires the command runner + onCommand.
  target.emit(keyEvent("e"));
  assert.deepEqual(fired, ["triage.archive", "onCommand:triage.archive"]);
  // Editable target: shortcut ignored.
  target.emit(keyEvent("e", { target: { tagName: "INPUT" } }));
  assert.deepEqual(fired, ["triage.archive", "onCommand:triage.archive"]);
  // destroy removes the listener.
  installed.destroy();
  assert.equal(target.listenerCount("keydown"), 0);
  target.emit(keyEvent("k", { metaKey: true }));
  assert.equal(installed.isOpen(), false);
});

test("installPalette validation", () => {
  assert.throws(() => installPalette({ target: null }), /target must provide addEventListener/);
  assert.throws(() => installPalette({ target: {} }), /target must provide addEventListener/);
});
