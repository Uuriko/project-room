import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_AUTONOMY_PERMISSIONS, PERMISSIONS, event } from "../src/events.js";
import { RoomStore } from "../server/store.mjs";
import { emitWorkClaimEvent } from "../server/work-claim-events.mjs";

export const FIXED_AT = "2026-09-30T15:00:00.000Z";
export const FIXED_MS = Date.parse(FIXED_AT);
export const LEAKS = ["LeakNameZZ", "LeakTitleZZ", "LeakBodyZZ", "LeakPathZZ", "leak@example.com"];

export function openRoom(t, { roomId = "alpha", title = "LeakTitleZZ", now = () => FIXED_MS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "analytics-an1a-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { now });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const room = event({
    id: `${roomId}-created`, type: "room.created", actorId: "owner", roomId, at: FIXED_AT,
    data: { roomId, ownerId: "owner", title, purpose: "leak@example.com", kind: "personal" }
  });
  const owner = event({
    id: `${roomId}-owner`, type: "member.added", actorId: "owner", roomId, at: FIXED_AT,
    data: { memberId: "owner", displayName: "LeakNameZZ", kind: "human", permissions: [...PERMISSIONS] }
  });
  const agent = event({
    id: `${roomId}-agent`, type: "member.added", actorId: "owner", roomId, at: FIXED_AT,
    data: {
      memberId: "agent1", displayName: "LeakNameZZ", kind: "agent", agentType: "cursor",
      referredBy: "owner", permissions: [...AGENT_AUTONOMY_PERMISSIONS]
    }
  });
  const message = event({
    id: `${roomId}-post`, type: "message.posted", actorId: "agent1", roomId, at: FIXED_AT,
    data: { body: "LeakBodyZZ" }
  });
  const referral = event({
    id: `${roomId}-referral`, type: "referral.completed", actorId: "owner", roomId, at: FIXED_AT,
    data: { referrerMemberId: "owner", refereeMemberId: "agent1", via: "invite", completedAt: FIXED_MS }
  });
  store.initialize([room, owner, agent, message, referral]);
  const claim = { id: "claim1", title: "LeakTitleZZ", files: ["LeakPathZZ"], owner: "agent1", leaseExpiresAt: null };
  store.transaction(() => {
    emitWorkClaimEvent(store, roomId, { actorId: "agent1", atMs: FIXED_MS, item: { ...claim, state: "unclaimed", owner: null }, action: "created" });
    emitWorkClaimEvent(store, roomId, { actorId: "agent1", atMs: FIXED_MS, item: { ...claim, state: "claimed" }, action: "claimed" });
    emitWorkClaimEvent(store, roomId, {
      actorId: "agent1", atMs: FIXED_MS, item: { ...claim, state: "done" }, action: "pr_merged",
      pullRequest: { url: "https://github.com/acme/demo/pull/7", outcome: "merged" }
    });
  });
  store.createAccount("acct1", "github");
  return { dir, store, file: join(dir, "room.sqlite"), roomId };
}
