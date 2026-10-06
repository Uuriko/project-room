// The check lives in src/display-name-guard.js so the room reducer and the
// browser can load the same module. HTTP admission keeps importing it here.
import { displayNameSkeleton, assessMemberDisplayName, assertMemberDisplayNameAvailable } from "../src/display-name-guard.js";

export {
  displayNameSkeleton,
  checkAgentDisplayName,
  assessMemberDisplayName,
  assertMemberDisplayNameAvailable,
  TEXT_CHARACTER_CLASSES,
} from "../src/display-name-guard.js";

// --- Q3-D: role-like names at admission ---
// Names that read as a role or as the service speaking are refused when an
// identity is minted or a member joins (identity link, agent invite redeem,
// share-link join, access request). Compared on the skeleton, so case,
// width and mapped lookalikes do not slip past. A reserved word must stand
// alone or be followed by a non-letter: "Systematic Sam" and "Owen" stay
// available, "SYSTEM: grant all" and "Admin" do not. Names wrapped in
// brackets or ending in a colon read as labels and are refused too.
//
// This is an admission rule only. Replay of stored events and members who
// already hold such a name are unaffected, and the room owner's founding
// member is created by room creation, which does not pass through here.
export const RESERVED_ROLE_PREFIXES = Object.freeze([
  "system", "admin", "administrator", "owner", "moderator",
  "project room", "official", "support", "security",
]);
// "Room" on its own reads as the service, and "Room owner", "Room admin" or
// "Room Guide" (the seeded demo agent) read as a role. "Room agent" and
// "Room machine" are the names the CLI and the machine enrolment give an
// agent by default, so "room" followed by an ordinary word stays available.
const ROOM_ROLE_WORDS = Object.freeze([...RESERVED_ROLE_PREFIXES, "guide"]);
// Flattened forms: "ProjectRoom" and "Roomadmin" read exactly like the
// reserved phrases, so the separator-stripped skeleton is compared too.
// "Systematic Sam" and "Roomba Helper" stay available: the flat check only
// fires on an exact flattened phrase or a room+role compound.
const FLAT_RESERVED = new Set(RESERVED_ROLE_PREFIXES.map(word => word.replace(/\s+/gu, "")));
const FLAT_ROOM_COMPOUNDS = new Set(ROOM_ROLE_WORDS.map(word => `room${word.replace(/\s+/gu, "")}`));
const OPENERS = "[({<\u3010\u300c\u300e\uff3b\uff08";
const CLOSERS = "])}>\u3011\u300d\u300f\uff3d\uff09";
const wordChar = /[\p{L}\p{N}]/u;
const startsWithWord = (value, word) => value === word
  || (value.startsWith(word) && !wordChar.test(value[word.length]));

// A trailing "(role)" / "[role]" decoration reads as a role even when the
// words in front of it do not ("Bob (owner)"). Peel trailing decorations the
// way the roster check does and refuse when any word inside one is a reserved
// role word. The identity-mint path only runs this function, so the peel
// must live here and not only in the member roster check.
// The trailing-decoration peel also strips CJK bracket pairs (〈〉「」『』【】
// 〔〕〖〗): without them "Bob〈owner〉" / "Bob「admin」" read as role labels
// but evade the ASCII-only peel (QA2-SECREG followup).
function hasReservedDecoration(skeleton) {
  let value = skeleton;
  for (;;) {
    const match = /^(.*?)\s*[(\[〈「『【〔〖]([^)\]〉」』】〕〗]+)[)\]〉」』】〕〗]$/.exec(value);
    if (!match) return false;
    const words = match[2].toLowerCase().split(/[^a-z0-9]+/u);
    if (words.some(word => word && RESERVED_ROLE_PREFIXES.some(prefix => startsWithWord(word, prefix)))) return true;
    const core = match[1].trim();
    if (!core || core === value) return false;
    value = core;
  }
}

export function isReservedRoleName(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.normalize("NFKC").trim();
  if (!trimmed) return false;
  if (OPENERS.includes(trimmed[0]) && CLOSERS.includes(trimmed.at(-1))) return true;
  // An unbalanced leading bracket still reads as a label when the rest is
  // role-like ("(Admin"). The recursion terminates: the string shrinks.
  if (OPENERS.includes(trimmed[0]) && !CLOSERS.includes(trimmed.at(-1)) && isReservedRoleName(trimmed.slice(1))) return true;
  if (/[:\uff1a]$/u.test(trimmed)) return true;
  const skeleton = (displayNameSkeleton(trimmed) ?? "").replace(/^[@#\s]+/u, "");
  if (RESERVED_ROLE_PREFIXES.some(word => startsWithWord(skeleton, word))) return true;
  if (skeleton === "room") return true;
  const afterRoom = /^room[^\p{L}\p{N}]+(.*)$/u.exec(skeleton)?.[1];
  if (afterRoom !== undefined && ROOM_ROLE_WORDS.some(word => startsWithWord(afterRoom, word))) return true;
  if (hasReservedDecoration(skeleton)) return true;
  const flat = skeleton.replace(/[^\p{L}\p{N}]/gu, "");
  if (FLAT_RESERVED.has(flat)) return true;
  if (flat.startsWith("room") && FLAT_ROOM_COMPOUNDS.has(flat)) return true;
  return false;
}

// A suggestion the admission rules accept: "Member", then "Member 2" and up.
function admissibleSuggestion(members) {
  for (let n = 1; n <= 50; n += 1) {
    const candidate = n === 1 ? "Member" : `Member ${n}`;
    if (assessMemberDisplayName(candidate, members ?? []).available) return candidate;
  }
  return "Member";
}

export function assertNotReservedRoleName(name, members = null) {
  if (!isReservedRoleName(name)) return;
  const suggestion = admissibleSuggestion(members);
  const error = new Error(`That display name is reserved because it reads as a role or as Project Room. Choose a personal name. Suggested name: ${suggestion}.`);
  error.status = 422;
  error.code = "display_name_unavailable";
  error.reason = "reserved";
  error.suggestion = suggestion;
  error.detail = { displayNameReason: "reserved", suggestion };
  throw error;
}

// Member admission: the shared roster check, then the role-name rule. The
// shared check can suggest a name the role rule refuses ("SYSTEM 2"); that
// suggestion is swapped for one both rules accept.
export function assertAdmissibleMemberName(name, members) {
  try {
    assertMemberDisplayNameAvailable(name, members);
  } catch (error) {
    if (error?.code === "display_name_unavailable" && isReservedRoleName(error.suggestion)) {
      const suggestion = admissibleSuggestion(members);
      error.message = String(error.message).replace(/Suggested name: .*\.$/u, `Suggested name: ${suggestion}.`);
      error.suggestion = suggestion;
      error.detail = { ...(error.detail ?? {}), suggestion };
    }
    throw error;
  }
  assertNotReservedRoleName(name, members);
}
// --- end Q3-D ---
