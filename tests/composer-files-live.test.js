import test from "node:test";
import assert from "node:assert/strict";
import { arrivalsNeedFileRefresh, attachFailureCopy, ROOM_FILE_REFRESH_DELAYS_MS } from "../src/composer-files.js";

test("file refresh distinguishes local sends from other sessions of the same account", () => {
  const local = new Set(["local-send"]);
  assert.equal(arrivalsNeedFileRefresh([{ id: "local-send", authorId: "me" }], local), false);
  assert.equal(arrivalsNeedFileRefresh([{ id: "other-session", authorId: "me" }], local), true);
  assert.equal(arrivalsNeedFileRefresh([{ id: "friend-send", authorId: "friend" }], local), true);
  assert.equal(arrivalsNeedFileRefresh([{ id: "local-send" }, { id: "other-session" }], local), true);
  assert.equal(arrivalsNeedFileRefresh([], local), false);
  assert.equal(arrivalsNeedFileRefresh(null, local), false);
  assert.equal(arrivalsNeedFileRefresh([{ id: "arrival" }]), true);
  assert.ok(ROOM_FILE_REFRESH_DELAYS_MS.length >= 2 && ROOM_FILE_REFRESH_DELAYS_MS[0] < ROOM_FILE_REFRESH_DELAYS_MS[1]);
});

test("a blocked file type reads as plain copy, not the server's wording", () => {
  assert.equal(attachFailureCopy({ code: "blocked_extension", message: 'extension ".exe" is blocked for security' }), "That file type isn’t allowed.");
  assert.equal(attachFailureCopy({ code: "file_too_large" }), "That file is larger than 1 MB.");
  assert.equal(attachFailureCopy({ message: "Network down" }), "Network down");
  assert.equal(attachFailureCopy(null), "Couldn’t attach that file.");
});
