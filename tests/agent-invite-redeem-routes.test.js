import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_INVITE_REDEEM_ROUTES } from "../server/routes/agent-invite-redeem.mjs";
import { ROUTES } from "../server/routes/table.mjs";

test("invite redeem serves POST and the fetch-only GET from the route table", () => {
  const rows = AGENT_INVITE_REDEEM_ROUTES.map(row => `${row.method} ${row.path}`);
  assert.deepEqual(rows.sort(), ["GET /api/agent-invites/redeem", "POST /api/agent-invites/redeem"]);
  for (const row of AGENT_INVITE_REDEEM_ROUTES) {
    assert.equal(row.auth, "none");
    assert.ok(ROUTES.includes(row), `${row.id} is mounted in the route table`);
  }
});
