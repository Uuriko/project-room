// K019: notification preferences. Pure preference tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createNotifyPrefs, NotifyError } from "../server/notify-prefs.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof NotifyError && error.code === code);

test("resolution order: thread > room > global > default", () => {
  const prefs = createNotifyPrefs();
  assert.equal(prefs.resolve("ada", { roomId: "r1" }), "mentions"); // default
  prefs.setGlobal("ada", { level: "all" });
  assert.equal(prefs.resolve("ada", { roomId: "r1" }), "all");
  prefs.setRoom("ada", { roomId: "r1", level: "muted" });
  assert.equal(prefs.resolve("ada", { roomId: "r1" }), "muted");
  assert.equal(prefs.resolve("ada", { roomId: "r2" }), "all"); // other room uses global
  prefs.setThread("ada", { threadId: "t1", level: "all" });
  assert.equal(prefs.resolve("ada", { roomId: "r1", threadId: "t1" }), "all"); // thread wins
});
test("malformed inputs are refused", () => {
  const prefs = createNotifyPrefs();
  throwsCode(() => prefs.setGlobal("ada", { level: "everything" }), "invalid_notify");
  throwsCode(() => prefs.setRoom("ada", { roomId: "", level: "all" }), "invalid_notify");
});
