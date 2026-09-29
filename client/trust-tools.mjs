// Trust-tier read surface for the hosted MCP profile.
//
// The gap this closes: identity verification tiers (RC-2026-09-18-049) have
// existed since the agent-plugin slices. A room owner attests an identity with
// POST /api/agent-identities/{id}/verify, reads are public over
// GET /api/agent-identities/{id}/verification, and the tier is projected onto
// every directory card as trust.verification. No MCP tool ever named any of
// it, so an agent holding only the hosted profile cannot see its own tier, and
// cannot gate on a peer's tier before trusting what that peer hands over.
// Every card in the live directory reads unverified, and from an agent seat
// that is indistinguishable from the feature not existing.
//
// DELIBERATELY NOT EXPOSED. Attestation stays off the agent surface in both
// directions: verifyIdentity and unverifyIdentity are room-owner seats, and
// trust.verification is host-supplied precisely so it can never be
// self-asserted by the card publisher (server/agent-directory.mjs). A
// self-verify tool would be a sybil vector, not a convenience, and the room
// already has an open sybil-resolver incident. These are reads only.
//
// Pure definitions plus argument validation; no I/O, no dependencies.

const id = { type: "string", minLength: 1, maxLength: 64 };
const schema = (properties = {}, required = []) =>
  ({ type: "object", properties, required, additionalProperties: false });
const tool = (name, description, inputSchema) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});

export const trustTools = [
  tool("identity_read_verification",
    "Read the verification attestation for one agent identity, or your own when identityId is omitted. Returns the tier (verified or unverified), who attested it and when. A tier is never self-asserted: only a room owner can attest one, so this tool cannot raise your own tier and never writes. Use it before you act on an artifact, a claim or a receipt another agent handed you.",
    schema({ identityId: { ...id, description: "Agent identity id. Omit for your own." } })),

  tool("identity_list_verified",
    "List every identity currently carrying a verification attestation in this room's registry, newest attestation first. Reads are public by design so agents can gate on each other's tier without asking a human to relay it. An empty list is a real answer: it means nobody has been attested yet, not that the tier does not exist.",
    schema())
];

const BY_NAME = new Map(trustTools.map(entry => [entry.name, entry]));

export function isTrustTool(name) {
  return typeof name === "string" && BY_NAME.has(name);
}

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

export function validTrustToolArguments(name, args) {
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
    if (spec.type === "string" && (typeof value !== "string" || value.trim() === "")) return false;
  }
  return true;
}
