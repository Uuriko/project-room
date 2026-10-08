// server/notify-classifier.mjs — the canonical two-trigger notification classifier.
//
// Lane B19 (Project Room herdr redesign). Sibling lane B8 was told to
// implement a local trigger predicate; THIS module is the canonical
// implementation and B8 consumes it — no second copy of the rule.
//
// `shouldNotify(event, prefs)` answers one question: "does this room event
// interrupt THIS member?" It is a pure function (no I/O, no imports beyond
// error helpers), deterministic, and logs nothing — the caller logs the
// classification tuple {class, addressee, thread, seq}. Malformed inputs
// throw; unknown event types default-deny (ambient), never throw.
//
// ---------------------------------------------------------------------------
// TRIGGER TAXONOMY (exhaustive — no third trigger without an owner decision)
// ---------------------------------------------------------------------------
// TRIGGER 1 — "a question / blocked item is addressed to the recipient"
//   There is no interrupt without a named addressee. The caller resolves
//   mentions/addressees BEFORE calling (mention-lifecycle resolution
//   semantics: memberId/displayName/identity name, sender skipped) and
//   passes them in event.addressedTo. The classifier never parses text.
//   1a. review_request — ALL of:
//         - type === "review_request"
//         - the recipient is an addressed target (event.addressedTo includes
//           them; covers both @mention resolution and structured
//           requested_reviewer fields on the payload)
//         - the referenced artifact is reviewable: event.reviewArtifact.status
//           === "needs_review" with artifact coordinates (claimId / prNumber
//           + headSha). A review request pointing at nothing reviewable is
//           malformed -> ambient (inbox card), not an interrupt.
//         - the mention lifecycle for (event -> recipient) is not
//           "responded". A fresh explicit request after "timed_out" RE-ARMS
//           the interrupt; while "delivered"/"acknowledged" it collapses
//           into the first (the caller's 30-minute dedupe window owns that).
//   1b. question — ALL of:
//         - type === "question" (ASK-prefixed or reply-request payload)
//         - the recipient is an addressed target.
//   1c. blocked — ALL of:
//         - type === "blocked" (a claim-board state-change event)
//         - the claim snapshot passed in still reads status === "blocked"
//           (self-reported by the lane, never inferred; the caller re-reads
//           the live board at classify time — the notification!=truth rule.
//           A block cleared since the event voids the interrupt HERE, before
//           it ever pushes. The classifier trusts only the data it is given.)
//         - event.claim.blockedOn names the recipient directly, OR names a
//           claim / PR / merge-slot the recipient owns (id found in
//           prefs.owned).
//
// TRIGGER 2 — "a finish/done lands on something the recipient owns or verifies"
//   2a. done — type === "done" and (claim.ownerId === recipient
//       or claim.id is in prefs.owned).
//   2b. done — type === "done" and (claim.verifierIds includes the recipient
//       or claim.id is in prefs.verifies).
//
// DEFAULT-DENY (ambient — routes to inbox/digest/nothing, NEVER pushes):
//   claims, claim updates, PROGRESS posts, CI results (green or red),
//   IDEA posts, general room chatter, plain @mentions (an @mention is an
//   addressing MECHANISM, not an interrupt — it upgrades only when Trigger
//   1a/1b conditions hold), heartbeat/presence, board sweeps, room-state
//   rebuilds, digest lines, "FYI" posts, review verdicts on others' work,
//   and ANY unknown/unrecognized event type.
//
// CROSS-CUTTING GUARDS:
//   - Self-suppression: an event whose senderId === prefs.memberId never
//     interrupts that member (the mention-lifecycle convention, extended).
//   - Quiet hours, batching/dedupe windows, rate caps, and the critical
//     class are NOT this module's job: they live downstream (attention.mjs,
//     human-push.mjs). This predicate is the shared contract — a future
//     text rail consumes the same classification.
// ---------------------------------------------------------------------------
//
// Input shapes:
//   event = {
//     type: string,                    // required; unknown -> deny
//     senderId: string | null,         // who emitted the event
//     seq: number | null,              // room event seq (staleness marker, informational)
//     addressedTo: string[],           // resolved member ids (caller-resolved)
//     reviewArtifact: { claimId, status, prNumber, headSha } | null,  // review_request
//     claim: { id, status, ownerId, verifierIds: [], blockedOn } | null, // blocked/done
//     mentionState: "delivered"|"acknowledged"|"responded"|"timed_out" | null,
//   }
//   prefs = {
//     memberId: string,                // required; the recipient being classified for
//     owned: string[],                 // claim/PR/merge-slot ids the recipient owns
//     verifies: string[],             // claim ids the recipient verifies
//   }
class ClassifierError extends Error {
  constructor(code, message) { super(message); this.name = "ClassifierError"; this.code = code; }
}
const fail = (code, message) => { throw new ClassifierError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_classifier_input", message); };

const REVIEWABLE_STATUS = "needs_review";
const BLOCKED_STATUS = "blocked";
const SUPPRESSED_MENTION_STATE = "responded";

const isNonEmptyString = value => typeof value === "string" && value.length > 0;

const toSet = value => {
  check(Array.isArray(value), "prefs lists must be arrays");
  return new Set(value.filter(isNonEmptyString));
};

// Pure predicate: does `event` interrupt `prefs.memberId`? Returns boolean.
export function shouldNotify(event, prefs) {
  check(event !== null && typeof event === "object" && !Array.isArray(event), "event must be an object");
  check(prefs !== null && typeof prefs === "object" && !Array.isArray(prefs), "prefs must be an object");
  const { memberId } = prefs;
  check(isNonEmptyString(memberId), "prefs.memberId must be a non-empty string");

  const { type, senderId = null } = event;
  check(type === undefined || typeof type === "string", "event.type must be a string if given");

  // Cross-cutting: never interrupt a member about their own event.
  if (senderId === memberId) return false;

  const addressedTo = Array.isArray(event.addressedTo) ? event.addressedTo : [];
  const isAddressed = addressedTo.includes(memberId);
  const mentionState = event.mentionState ?? null;

  switch (type) {
    case "review_request":
      return trigger1a({ isAddressed, mentionState, reviewArtifact: event.reviewArtifact ?? null });
    case "question":
      return trigger1b({ isAddressed });
    case "blocked":
      return trigger1c({ memberId, owned: toSet(prefs.owned ?? []), claim: event.claim ?? null });
    case "done":
      return trigger2({
        memberId,
        owned: toSet(prefs.owned ?? []),
        verifies: toSet(prefs.verifies ?? []),
        claim: event.claim ?? null,
      });
    default:
      // Default-deny: every unrecognized type is ambient, never an interrupt.
      return false;
  }
}

// Trigger 1a: review explicitly requested of the recipient on a reviewable artifact.
function trigger1a({ isAddressed, mentionState, reviewArtifact }) {
  if (!isAddressed) return false;
  // Terminal mention state "responded" suppresses re-fire. A fresh request
  // after "timed_out" re-arms (timed_out is NOT suppressing here).
  if (mentionState === SUPPRESSED_MENTION_STATE) return false;
  if (reviewArtifact === null || typeof reviewArtifact !== "object") return false;
  // The artifact must exist in a reviewable state — otherwise the request is
  // malformed and becomes an inbox card, not an interrupt.
  return reviewArtifact.status === REVIEWABLE_STATUS;
}

// Trigger 1b: question explicitly addressed to the recipient.
function trigger1b({ isAddressed }) {
  return isAddressed;
}

// Trigger 1c: a claim-board entry is blocked on the recipient (directly or
// via something they own), and the block is still live at classify time.
function trigger1c({ memberId, owned, claim }) {
  if (claim === null || typeof claim !== "object") return false;
  // Stale block: the entry moved off "blocked" since the event — no interrupt.
  if (claim.status !== BLOCKED_STATUS) return false;
  if (!isNonEmptyString(claim.blockedOn)) return false;
  return claim.blockedOn === memberId || owned.has(claim.blockedOn);
}

// Trigger 2: finish/done on something the recipient owns or verifies.
function trigger2({ memberId, owned, verifies, claim }) {
  if (claim === null || typeof claim !== "object") return false;
  if (!isNonEmptyString(claim.id)) return false;
  if (claim.ownerId === memberId) return true;
  if (owned.has(claim.id)) return true;
  const verifierIds = Array.isArray(claim.verifierIds) ? claim.verifierIds : [];
  if (verifierIds.includes(memberId)) return true;
  return verifies.has(claim.id);
}
