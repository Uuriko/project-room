// KI-070 / KI-012: bounties are cut from the MVP (Potter, 2026-10-30). Until
// the money surface is removed outright, new bounty work is paused: posting,
// funding, claiming and submitting refuse with 403 bounties_paused. Reads,
// acceptance, disputes, finalize and transfers keep working so value already
// held in escrow can still settle.
//
// Default: paused in production (ROOM_DEPLOYMENT=production), on elsewhere so
// staging and the test suite keep exercising the escrow. ROOM_BOUNTY_WORK=1
// turns new work back on; ROOM_BOUNTY_WORK=0 pauses it anywhere.
export const BOUNTY_NEW_WORK_ROUTES = new Set(["create", "fund", "claim", "submit"]);
export const BOUNTY_NEW_WORK_TOOLS = new Set(["bounty_post", "bounty_fund", "bounty_claim", "bounty_submit"]);

export const BOUNTIES_PAUSED_CODE = "bounties_paused";
export const BOUNTIES_PAUSED_MESSAGE =
  "New bounty work is paused: bounties are cut from the MVP. Existing bounties can still be read, accepted, disputed, finalized and transferred. For new work use the Board: POST /api/rooms/{roomId}/work-claims.";

export function bountyNewWorkEnabled(env = globalThis.process?.env ?? {}) {
  if (env.ROOM_BOUNTY_WORK === "1") return true;
  if (env.ROOM_BOUNTY_WORK === "0") return false;
  return env.ROOM_DEPLOYMENT !== "production";
}
