// Permission modes per agent per room (Town-style autonomy levels).
//   ask   every change waits for the owner (default)
//   safe  safe actions run on their own; anything else waits
//   all   everything runs; the owner reviews afterwards
export const PERMISSION_MODES = Object.freeze(["ask", "safe", "all"]);
export const DEFAULT_MODE = "ask";
// Reads and in-room, reversible work. Anything that leaves Room, spends,
// deletes or touches main is never safe.
export const SAFE_ACTIONS = Object.freeze(["read", "post_message", "reply", "claim", "release_claim", "run_tests", "open_draft_pr", "draft", "update_presence"]);
export const ACTION_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

// "allow" or "ask". Reads are always allowed: they change nothing.
export function decide(mode, action) {
  if (!PERMISSION_MODES.includes(mode) || typeof action !== "string" || !ACTION_PATTERN.test(action)) return null;
  if (action === "read" || mode === "all") return "allow";
  if (mode === "safe" && SAFE_ACTIONS.includes(action)) return "allow";
  return "ask";
}
