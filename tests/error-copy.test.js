import test from "node:test";
import assert from "node:assert/strict";
import { humanErrorMessage, ERROR_KEYS } from "../src/error-copy.js";

// Fail-first: the client must never show a generic "Unknown error" /
// "Request failed" fallthrough. Every fallthrough code gets a specific,
// plain-language message with a recovery action.

const GENERIC = /unknown error|request failed/i;

test("spot-checked fallthrough codes map to specific human copy", () => {
  assert.equal(
    humanErrorMessage({ status: 404, code: "room_not_found" }),
    "That room doesn't exist. Check the room link, or ask the owner for a new invite."
  );
  assert.equal(
    humanErrorMessage({ status: 410, code: "invite_expired" }),
    "That invite code expired. Ask the host for a fresh code."
  );
  assert.equal(
    humanErrorMessage({ status: 409, code: "too_many_open_claims" }),
    "You already hold the maximum number of open claims. Release or finish one before taking another."
  );
  assert.equal(
    humanErrorMessage({ status: 409, code: "budget_exceeded" }),
    "The session's spending budget was exceeded, and the session was stopped. Start a new session with a higher budget."
  );
});

test("every registered fallthrough code has specific non-generic copy", () => {
  assert.ok(ERROR_KEYS.size > 100, `expected the full fallthrough set, got ${ERROR_KEYS.size}`);
  for (const code of ERROR_KEYS) {
    const text = humanErrorMessage({ status: 409, code });
    assert.ok(typeof text === "string" && text.length > 20, `${code}: message too short`);
    assert.doesNotMatch(text, GENERIC, `${code}: still generic`);
    // Recovery action: the copy must tell the human what to do next.
    assert.match(text, /\./, `${code}: no sentence boundary`);
  }
});

test("codes outside the table keep the server message when it is specific", () => {
  assert.equal(
    humanErrorMessage({ status: 409, code: "stale_session_revision", message: "Account session changed" }),
    "Account session changed"
  );
});

test("unknown codes fall back to status copy, never a generic", () => {
  assert.equal(
    humanErrorMessage({ status: 401, code: "some_future_code" }),
    "You're not signed in. Sign in and try again."
  );
  assert.equal(
    humanErrorMessage({ status: 409, code: "some_future_code" }),
    "That conflicts with the current state. Refresh and try again."
  );
  assert.equal(
    humanErrorMessage({ status: 500, code: "some_future_code" }),
    "Something went wrong on our side. Try again in a moment."
  );
  assert.equal(
    humanErrorMessage({ status: 429, code: "some_future_code" }),
    "You're doing that a bit too fast. Wait a moment and try again."
  );
});

test("missing code and status still produce a human sentence", () => {
  const text = humanErrorMessage({});
  assert.equal(text, "Something went wrong. Please try again.");
  assert.doesNotMatch(text, GENERIC);
  assert.doesNotMatch(humanErrorMessage({ status: 503 }), GENERIC);
});

test("money-adjacent copy never promises cash", () => {
  for (const code of ["budget_exceeded", "spend_allowance_exceeded", "pilot_limit"]) {
    const text = humanErrorMessage({ code });
    assert.doesNotMatch(text, /cash|payout|paid out/i, `${code}: overpromises money`);
  }
});

test("RoomClient throw sites resolve human copy instead of generics", async () => {
  const { RoomClient } = await import("../src/client.js");
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const client = new RoomClient({ fetcher: async () => response({ error: { code: "too_many_open_claims", message: "raw server text" } }, 409) });
  await assert.rejects(
    client.request("/api/rooms/x/work"),
    /maximum number of open claims.*Release or finish one/
  );
  const bare = new RoomClient({ fetcher: async () => response({}, 500) });
  const error = await bare.request("/api/session").catch(e => e);
  assert.equal(error.message, "Something went wrong on our side. Try again in a moment.");
  assert.doesNotMatch(error.message, /unknown error|request failed/i);
  // error.code is preserved for code-specific UI logic.
  const coded = new RoomClient({ fetcher: async () => response({ error: { code: "room_archived", message: "archived" } }, 409) });
  const err = await coded.request("/api/session").catch(e => e);
  assert.equal(err.code, "room_archived");
});
