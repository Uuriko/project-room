// Invite session expiration (2026-09-23): the /join success screen must show
// the genuine room-session expiration from the server, not a hardcoded guess.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatInviteExpiry } from "../src/join.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const http = readFileSync(join(ROOT, "server/http.mjs"), "utf8");
const joinJs = readFileSync(join(ROOT, "src/join.js"), "utf8");
const joinHtml = readFileSync(join(ROOT, "join.html"), "utf8");

test("/join response carries the session expiration", () => {
  const marker = "sessionExpiresAt: joined.expiresAt";
  assert.ok(http.includes(marker), "the /join 201 body includes sessionExpiresAt from the minted session");
});

test("success screen has a session-expiry element", () => {
  assert.ok(joinHtml.includes('id="join-session-expiry"'), "join.html has the join-session-expiry paragraph");
});

test("join.js renders the server-provided expiration on success", () => {
  assert.ok(joinJs.includes("sessionExpiresAt"), "join.js reads sessionExpiresAt from the join response");
  assert.ok(
    joinJs.includes("This browser session expires"),
    "join.js writes a human-readable expiration line to the success screen"
  );
  assert.ok(
    joinJs.includes("expiryEl.hidden = false") && joinJs.includes("expiryEl.hidden = true"),
    "join.js hides the expiry paragraph when there is no expiration to show"
  );
});

test("session expiry formats like invite expiry", () => {
  const now = 1_000_000;
  // 8-hour join sessions (server/store.mjs createJoinSession) render as hours.
  assert.equal(formatInviteExpiry(now + 8 * 3_600_000, now), "in 8 hours");
});
