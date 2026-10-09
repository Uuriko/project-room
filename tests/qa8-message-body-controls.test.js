// QA8 (2026-10-08, live prod; gap-hunt D-M2): message bodies with NUL and
// bidi override characters were accepted and stored verbatim. In the room UI
// "x \u202Eexe.txt" rendered as "x txt.exe" (display spoofing in chat and in
// agent transcripts). The Board already refuses these; message.posted,
// message.edited and dm.posted bodies now do too, with a named 422.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateCommand } from "../server/store.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const run = (type, data) => validateCommand({ id: randomUUID(), type, data });
const refused = (type, data, pattern) => assert.throws(() => run(type, data), error => {
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_command");
  assert.match(error.message, pattern);
  return true;
});

test("message bodies refuse NUL, unpaired surrogates and bidi embedding/override/isolate controls", () => {
  for (const type of [T.MESSAGE_POSTED, T.MESSAGE_EDITED]) {
    const base = type === T.MESSAGE_EDITED ? { messageId: "m1" } : {};
    refused(type, { ...base, body: "a\u0000b" }, /NUL/);
    refused(type, { ...base, body: "bad \ud800 surrogate" }, /unpaired surrogate/);
    for (const ch of ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069"]) {
      refused(type, { ...base, body: `invoice ${ch}fdp.exe` }, /bidirectional/);
    }
  }
  refused(T.DM_POSTED, { to: "ai_x", messageId: "m2", body: "x \u202Eexe.txt" }, /bidirectional/);
});

test("ordinary multilingual text, marks, tabs, ANSI escapes and emoji stay allowed", () => {
  for (const body of [
    "héllo 日本語 مرحبا עברית",
    "RTL with marks \u200Fمرحبا\u200E ok",
    "tab\tseparated\nnew line\r\nwindows",
    "\u001b[31mred\u001b[0m terminal output",
    "family 👨‍👩‍👧 and 👋🏽",
  ]) {
    assert.doesNotThrow(() => run(T.MESSAGE_POSTED, { body }), body);
  }
});
