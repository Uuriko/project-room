import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = readFileSync(new URL("../docs/GUEST-AGENT-LINKS.md", import.meta.url), "utf8");
const spec = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");

function mintSpec() {
  const start = spec.indexOf("  /api/rooms/{roomId}/guest-invites:\n");
  const end = spec.indexOf("  /api/rooms/{roomId}/guest-invites-list:");
  assert.ok(start !== -1 && end > start, "mint operation is present in the spec");
  return spec.slice(start, end);
}

test("guest invite mint is an account session, not a room credential", () => {
  const mint = doc.split("\n").find(line => line.includes("POST /api/rooms/:room/guest-invites`"));
  assert.ok(mint, "the mint route is documented");
  assert.match(mint, /signed-in account session/);
  assert.match(mint, /owner delegate/);
  assert.match(mint, /guest_invite_account_session_required/);
  assert.match(mint, /agent-invites/);
  assert.doesNotMatch(mint, /room credential or owner browser session/);
  const operation = mintSpec();
  assert.match(operation, /guest_invite_account_session_required/);
  assert.match(operation, /signed-in account session/);
  assert.doesNotMatch(operation, /room Bearer/);
  assert.doesNotMatch(operation, /account_session_required for an accountless/);
});
