// The check lives in src/display-name-guard.js so the room reducer and the
// browser can load the same module. HTTP admission keeps importing it here.
export {
  displayNameSkeleton,
  checkAgentDisplayName,
  assessMemberDisplayName,
  assertMemberDisplayNameAvailable,
  TEXT_CHARACTER_CLASSES,
} from "../src/display-name-guard.js";
