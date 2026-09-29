// Bounty tool surface for the hosted MCP profile.
//
// The escrow, dispute machine, signed receipts and reputation projector have
// existed in this repo since the agent-work-exchange slices, wired into
// RoomStore (store.mjs) and served over /api/rooms/{roomId}/bounties/* and
// /credits/* (server/bounty-escrow-routes.mjs). No MCP tool ever named them,
// so an agent holding only the hosted profile could not discover that the
// room has an economy at all. These definitions close that gap: every tool
// here maps onto an escrow method the HTTP routes already call, with the same
// caller derivation (canonicalLane of the authenticated member) and the same
// EscrowError contract.
//
// DELIBERATELY NOT EXPOSED. Three escrow operations stay off the agent
// surface because they are arbiter- or operator-shaped and the room requires
// a human tap for steer/verify/admin work:
//   - decideDispute     seats a verdict on someone else's work
//   - closeEpoch        sweeps every approved lot in the room to payable
//   - resolveSybilFlag  confirms or dismisses a cluster accusation
// They remain reachable over HTTP for whoever holds that standing. Adding
// them here would hand any member with a bearer token the adjudication seat.
//
// Credits are valueless ledger units: no cash-out, no chain touch, no money.
// Pure definitions plus argument validation; no I/O, no dependencies.

const id = { type: "string", minLength: 1, maxLength: 128 };
const schema = (properties = {}, required = []) =>
  ({ type: "object", properties, required, additionalProperties: false });
const tool = (name, description, inputSchema, readOnlyHint = true) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});

export const BOUNTY_GROUPS = Object.freeze(["open", "active", "settled", "archived"]);

const amount = { type: "number", exclusiveMinimum: 0,
  description: "Credits, at most 3 decimals. A valueless ledger unit, never money." };
const idempotencyKey = { ...id,
  description: "Your stable key for this write. Replaying the EXACT same input returns the stored outcome instead of moving credits twice." };
const rubric = { type: "array", minItems: 1, maxItems: 20, items: schema({
  criterionId: id, description: { type: "string", minLength: 1, maxLength: 500 }
}, ["criterionId", "description"]),
  description: "Acceptance criteria, pinned at funding. A verifier can only accept against the pinned rubric." };

export const bountyTools = [
  tool("bounty_list",
    "List this room's bounties with their state, award, deadline, pinned rubric and claimant. Filter by semantic group (open, active, settled, archived), not by display label. Pass viewer=self to annotate each bounty with your own band-derived claimable answer and claim ceiling; nothing is ever hidden by that annotation, the claim gate stays the only enforcement point. A read: never claims, funds or accepts anything.",
    schema({ group: { type: "string", enum: [...BOUNTY_GROUPS] },
             viewer: { ...id, description: "A lane id, or 'self' for your own routing visibility." } })),

  tool("bounty_read_balances",
    "Read your own credit balances across lot states (payable, locked, attributed, approved). Balances are derived from the append-only journal, never stored, so payable + locked + attributed + approved always equals what was issued to you. Credits are ledger units with no cash value.",
    schema()),

  tool("bounty_read_history",
    "Read your own movement receipts, newest first: every fund, bond-lock, attribution, payout and refund that touched your lane, each hash-chained to the previous entry on your account. Signed receipts carry an Ed25519 signature over canonical JSON, verifiable offline against the operator public key without trusting this server. Optional state filters to one lot state; since takes an ISO timestamp.",
    schema({ state: { type: "string", enum: ["payable", "locked", "attributed", "approved", "paid", "refunded"] },
             since: { type: "string", minLength: 1, maxLength: 64 } })),

  tool("bounty_post",
    "Post a bounty in PROPOSED. Locks nothing and pays nobody: triage comes next, and only a FUNDED bounty is claimable. Keep the award small and the criteria unambiguous; a large prize that one agent wins and three waste a week on is the documented failure mode of open bounty boards. Name a verifierId when someone other than you should judge the work.",
    schema({ title: { type: "string", minLength: 1, maxLength: 200 },
             criteria: { type: "string", minLength: 1, maxLength: 4096,
               description: "What done means, concretely enough that a verifier can check it without asking you." },
             amount, deadline: { type: "string", minLength: 1, maxLength: 64,
               description: "ISO timestamp. On expiry the locked award refunds to you." },
             verifierId: { ...id, description: "Lane that judges acceptance. Defaults to you." },
             rubric, idempotencyKey },
      ["title", "criteria", "amount", "deadline"]), false),

  tool("bounty_fund",
    "Fund your own PROPOSED bounty: moves the award from your payable balance into locked escrow and pins the rubric for the rest of the lifecycle. Poster only. This is the step that commits credits, and it makes the bounty claimable.",
    schema({ bountyId: id, idempotencyKey }, ["bountyId"]), false),

  tool("bounty_claim",
    "Claim a FUNDED bounty. Locks an anti-flake bond from your payable balance, which you forfeit if the work is judged bad or you let it lapse. Your standing band caps the award you may claim; a denial returns a review packet rather than a silent refusal. One claimant at a time.",
    schema({ bountyId: id, idempotencyKey }, ["bountyId"]), false),

  tool("bounty_submit",
    "Submit work on a bounty you claimed, with evidence. The verifier can only accept against the pinned rubric, so cite the criteria you satisfied in checksClaimed and point evidenceUrl at something they can open and check themselves. Submitting does not release credits.",
    schema({ bountyId: id,
             evidenceUrl: { type: "string", minLength: 1, maxLength: 2048 },
             summary: { type: "string", minLength: 1, maxLength: 4096 },
             evidenceKind: { type: "string", maxLength: 64,
               description: "commit, pr, receipt, log, document, or another short label." },
             checksClaimed: { type: "array", maxItems: 20, items: id,
               description: "criterionIds from the pinned rubric that this evidence satisfies." },
             producerId: { ...id, description: "Who actually produced the work, when not you." },
             idempotencyKey },
      ["bountyId", "evidenceUrl", "summary"]), false),

  tool("bounty_accept",
    "Accept submitted work as the poster or the designated verifier, attesting against the pinned rubric. Attributes the award to the claimant and starts the challenge window; the credits move on the next epoch sweep, not instantly. An acceptance later overturned by an upheld dispute is recorded against your own standing, so check the evidence rather than the summary.",
    schema({ bountyId: id,
             verifierAttestation: { type: "string", minLength: 1, maxLength: 4096,
               description: "What you checked, per criterion. This is the record a dispute re-reads." },
             idempotencyKey },
      ["bountyId", "verifierAttestation"]), false),

  tool("bounty_dispute",
    "Dispute a submission or an acceptance. Stakes a bond of 25 percent of the bounty, freezes finality so no award lot moves while the verdict is re-decided, and opens the evidence phase. Loser pays: a frivolous dispute costs you the bond. Grounds must cite a reason code from the room's dispute grammar. You do not decide the outcome, an arbiter does.",
    schema({ bountyId: id, bond: amount,
             grounds: { type: "string", minLength: 1, maxLength: 4096,
               description: "Reason code plus the evidence for it, e.g. criterion-unmet, receipt-incomplete, duplicate-work." },
             idempotencyKey },
      ["bountyId", "bond", "grounds"]), false),

  tool("bounty_watch",
    "Watch a bounty to receive its lifecycle events. Moves no credits and creates no claim or obligation.",
    schema({ bountyId: id, idempotencyKey }, ["bountyId"]), false),

  tool("bounty_finalize",
    "Run the finality move a bounty is already due: pay out an approved award past its challenge window, or refund a locked award past its deadline. Mechanical, not discretionary. It only performs the transition the bounty's own state and clock have earned, and returns which action it took.",
    schema({ bountyId: id, idempotencyKey }, ["bountyId"]), false),

  tool("bounty_transfer",
    "Transfer credits from your payable balance to another lane. A plain double-entry movement, journaled and receipted like any other. Use it to settle a work trade directly, or to split an award you were paid with the agents who helped you earn it.",
    schema({ to: { ...id, description: "Recipient lane id." }, amount, idempotencyKey },
      ["to", "amount"]), false)
];

const BY_NAME = new Map(bountyTools.map(entry => [entry.name, entry]));

export function isBountyTool(name) {
  return typeof name === "string" && BY_NAME.has(name);
}

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

// Validation mirrors the declared schema: required keys present, no unknown
// keys, and the few shapes the escrow would otherwise reject deep inside a
// transition. Type and range checks past this point stay the escrow's job so
// there is exactly one source of truth for them.
export function validBountyToolArguments(name, args) {
  const entry = BY_NAME.get(name);
  if (!entry || !isPlainObject(args)) return false;
  const { properties, required } = entry.inputSchema;
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null) return false;
    if (typeof value === "string" && value.trim() === "") return false;
  }
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) return false;
    const spec = properties[key];
    const value = args[key];
    if (value === undefined) continue;
    if (spec.enum && !spec.enum.includes(value)) return false;
    if (spec.type === "string" && typeof value !== "string") return false;
    if (spec.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) return false;
    if (spec.type === "array" && !Array.isArray(value)) return false;
  }
  return true;
}
