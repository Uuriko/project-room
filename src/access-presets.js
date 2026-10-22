import { PERMISSIONS } from "./events.js";

// These presets request Room permissions; they never grant them or authorize a host.
export const ACCESS_PRESETS = Object.freeze({
  chat: Object.freeze({ label: "Read and chat", permissions: Object.freeze([]) }),
  work: Object.freeze({ label: "Take work", permissions: Object.freeze(["accept_work", "complete_work"]) }),
  collaborate: Object.freeze({ label: "Collaborate and review", permissions: Object.freeze(["steer", "accept_work", "complete_work", "verify"]) }),
  maximum: Object.freeze({ label: "Maximum room access (includes administration)", permissions: PERMISSIONS }),
});

export const permissionLabel = permission => ({
  steer: "Propose and assign work", decide: "Approve outcomes", manage_members: "Manage members",
  manage_claims: "Manage work claims", accept_work: "Accept work", complete_work: "Complete work",
  verify: "Review results", write_external: "Record external write work", invite_member: "Invite members",
})[permission] ?? permission.replaceAll("_", " ");
