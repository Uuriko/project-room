import test from "node:test";
import assert from "node:assert/strict";
import { sidebarSectionsInUse } from "../src/room-layout.js";

const owner = { id: "owner", kind: "human" };
const agent = { id: "helper", kind: "agent" };

test("a new room with its owner and an agent shows neither Landing nor Referrals", () => {
  assert.deepEqual(sidebarSectionsInUse({ members: { owner, helper: agent }, workItems: {} }), { landing: false, referrals: false });
  assert.deepEqual(sidebarSectionsInUse(null), { landing: false, referrals: false });
});

test("Landing appears for write-mode work or a claim, not for read-only tasks", () => {
  const members = { owner };
  assert.equal(sidebarSectionsInUse({ members, workItems: { a: { mode: "read" } } }).landing, false);
  assert.equal(sidebarSectionsInUse({ members, workItems: { a: { mode: "read" }, b: { mode: "write" } } }).landing, true);
  assert.equal(sidebarSectionsInUse({ members, workItems: { a: { mode: "read", claim: { repository: "o/r" } } } }).landing, true);
});

test("Referrals appear for a second active human or a referral join", () => {
  const workItems = {};
  assert.equal(sidebarSectionsInUse({ members: { owner, gone: { id: "gone", kind: "human", active: false } }, workItems }).referrals, false);
  assert.equal(sidebarSectionsInUse({ members: { owner, guest: { id: "guest", kind: "human" } }, workItems }).referrals, true);
  assert.equal(sidebarSectionsInUse({ members: { owner, helper: { ...agent, referredBy: "owner" } }, workItems }).referrals, true);
});
