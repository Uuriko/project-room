// The check lives in src/display-name-guard.js so the room reducer and the
// browser can load the same module. HTTP admission keeps importing it here.
export {
  displayNameSkeleton,
  checkAgentDisplayName,
  assessMemberDisplayName,
  assertMemberDisplayNameAvailable,
} from "../src/display-name-guard.js";
