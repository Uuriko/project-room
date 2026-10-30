// Unicode tag characters (U+E0000-E007F) are invisible and were stored in
// message bodies. They are refused with a named 422. Other text stays.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateCommand } from "../server/store.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const run = (type, data) => validateCommand({ id: randomUUID(), type, data });
const refused = (type, data) => assert.throws(() => run(type, data), error => {
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_command");
  assert.equal(error.message, "body must not contain Unicode tag characters (U+E0000-E007F)");
  return true;
});

test("message bodies refuse Unicode tag characters", () => {
  for (const body of ["hello\u{E0000}", "hello\u{E007F}", "\u{E0001}", "a\u{E0061}b"]) {
    refused(T.MESSAGE_POSTED, { body });
    refused(T.MESSAGE_EDITED, { messageId: "m1", body });
    refused(T.DM_POSTED, { to: "ai_x", messageId: "m2", body });
  }
  for (const body of ["hello", "café", "İstanbul", "family 👨‍👩‍👧", "e\u0301"]) {
    assert.doesNotThrow(() => run(T.MESSAGE_POSTED, { body }), body);
  }
});
