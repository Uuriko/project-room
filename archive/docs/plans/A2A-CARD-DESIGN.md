# A2A v1.0 Agent Card alignment — design

Task: RC-2026-09-27-2715 (lane: jill). Date: 2026-09-27.
Branch: `jill/a2a-card-jws-2026-09-27`.

## 1. Current state (origin/main)

- The room serves a discovery document at `/.well-known/agent-card.json`
  (also `/.well-known/agent.json` alias) built by `agentCard()` in
  `deploy/agent-discovery.mjs`. It already borrows A2A v1.0 field conventions:
  `supportedInterfaces[]` (HTTP+JSON + MCP bindings), `securitySchemes` /
  `securityRequirements`, `capabilities` (with the `extensions[]` work-receipt
  extension), `skills[]` with id/name/description/tags.
- The card honestly declares it is NOT the A2A JSON-RPC protocol:
  `protocol: "project-room-discovery"`, and the description states the machine
  surfaces are HTTP+JSON and MCP, not A2A JSON-RPC. `protocolVersion` is the
  discovery version, not "1.0".
- Signature today is **proprietary** (RC-2026-09-23-105): house Ed25519 over
  canonical subset bytes (`server/agent-card-signing.mjs`), served as envelope
  fields `keyId`, `signatureAgentId`, `publicKey`, `cardSignature`,
  `signedRevision`. The envelope attaches only when the signature covers
  exactly the served build's revision; otherwise the card ships unsigned.
- **Production is currently UNSIGNED** (tap #59 — the owner's signing key is
  not in custody). This design must not depend on John's key in any way; the
  real key slots into the existing `scripts/sign-agent-card.mjs` flow later.

## 2. What A2A v1.0 requires (researched 2026-09-27)

Sources: `a2aproject/A2A` `docs/specification.md` §8.4 (Agent Card signing),
plus community implementation notes. Key points:

- `signatures`: array of `AgentCardSignature` objects —
  `protected` (required, base64url-encoded JWS Protected Header JSON),
  `signature` (required, base64url-encoded signature bytes),
  `header` (optional, unprotected header as a plain JSON object).
- The JWS Protected Header **MUST** include `alg` and `kid`;
  `typ` **SHOULD** be `"JOSE"`; it **MAY** include `jku`
  (URL to a JWKS containing the public key).
- Signature generation: (1) payload = card minus `signatures`
  (no other stripping — see §3.3), canonicalized with **RFC 8785 (JCS)**;
  (2) JWS Signing Input =
  `ASCII(BASE64URL(UTF8(protected)) || '.' || BASE64URL(payload))`;
  (3) sign with the `alg` algorithm; base64url-encode the result.
- Verification: extract the signature, resolve the key via `kid`/`jku`
  (or a trusted store), strip `signatures`, re-canonicalize (JCS), verify.
- Signing is a **SHOULD**, not a MUST — an unsigned card is spec-valid
  ("useful in curated registries, optional for direct discovery").

## 3. Decisions

### 3.1 Augment, don't replace, the proprietary signature

Add an A2A v1.0 `signatures[]` array alongside the existing envelope.
Rationale:

- The house envelope is already documented (`docs/SIGNED-AGENT-CARDS.md`),
  build-fail-closed (`scripts/sign-agent-card.mjs` stops a release without a
  valid key unless `--allow-unsigned` is passed explicitly), and carries a
  room-specific `signedRevision` binding (anti-replay against a stale signed
  card served from a newer build) that A2A has no equivalent for.
- Existing verifiers (room tooling, agents following the custody docs) keep
  working untouched.
- The JWS path is purely additive for A2A-native clients.

Both attach under the **same revision gate**; when unsigned, **neither**
appears — production's current unsigned state is byte-identical to today.

### 3.2 Algorithm: EdDSA (Ed25519)

The pinned room key (`deploy/agent-card-key.mjs`) is already Ed25519, so no
new key material and no new custody — zero dependence on John's tap.
In JWS terms the `alg` is `"EdDSA"` (RFC 8037; the curve rides in the JWK as
`crv: "Ed25519"`). Node's `crypto.sign(null, data, ed25519Key)` is PureEdDSA,
exactly what JWS EdDSA requires.

### 3.3 Payload canonicalization

Follow the spec literally: payload = **JCS (RFC 8785) over the card minus
the `signatures` field**. Our existing `canonicalize()` (recursive key sort,
no whitespace, arrays keep order) *is* JCS for this payload — the card
contains only strings, booleans, arrays, and objects (no floats, no
exotic types).

Note on the spec's "remove properties with default values" (verified against
the official A2A v1.0 text 2026-09-27): the rule is defined against the A2A
*proto* schema via ProtoJSON explicit presence — an explicitly-set optional
field **keeps** its default value (the spec's own example includes
`pushNotifications: false` and `protocolVersion: ""` when present). The
room's discovery card is not a proto message, so there is no proto schema to
judge defaults against; every property present in the served card is
significant, and the payload is the served card minus `signatures`, nothing
else. Verifiers MUST apply the same rule or signatures will not match.

Build-time computation order (so the payload is deterministic for verifiers):

1. build the base card (no envelope, no signatures);
2. compute the house signature, attach the legacy envelope;
3. compute the JWS over **(card + envelope) minus `signatures`**, attach
   `signatures`.

A verifier fetches the card, removes `signatures`, JCS-canonicalizes, and
verifies against the key from `kid`/`jku`. The envelope fields are stable
deterministic strings, so the recomputed bytes match. The spec's "exclude the
`signatures` field" rule is honored exactly; no verifier needs to know about
our legacy envelope fields.

### 3.4 Key discovery: `kid` + `jku` → JWKS

- Protected header: `{"alg":"EdDSA","typ":"JOSE","kid": AGENT_CARD_KEY_ID,
  "jku": "https://room.trydemigod.com/.well-known/jwks.json"}`.
- Serve `/.well-known/jwks.json` from the **committed pinned public key**
  (public data — safe to publish, key rotation handled by updating the file):
  `{"keys":[{"kty":"OKP","crv":"Ed25519","x":"<base64url>","kid":"<key-id>"}]}`.
- The JWKS endpoint is served **always** (even when the card is unsigned):
  it advertises the verification key; an unsigned card simply carries no
  `signatures`. This also keeps key-rotation discovery working later.
- `jku` uses the canonical room origin (`ROOM_ORIGIN`).

### 3.5 No-key behavior (must not break unsigned prod)

Unchanged from today, extended to the JWS path:

- `scripts/sign-agent-card.mjs` without a usable key still fails closed by
  default (release stopped), and with the explicit `--allow-unsigned` writes
  nulls for **both** `AGENT_CARD_SIGNATURE` and the new
  `AGENT_CARD_JWS_SIGNATURES`.
- `agentCard()` attaches `signatures` only when a signature exists **and**
  `AGENT_CARD_SIGNED_REVISION === deployed.revision` — the same gate as the
  legacy envelope.
- Result: unsigned prod serves a card with **no** signature fields at all,
  exactly as today; the unsigned card is spec-valid per §8.4 (signing is
  optional for direct discovery).

### 3.6 Backward compatibility

- Legacy envelope fields (`keyId`, `signatureAgentId`, `publicKey`,
  `cardSignature`, `signedRevision`) are untouched in shape and semantics.
- New fields: `signatures[]` on the card, `/.well-known/jwks.json` route.
- No route or behavior changes otherwise. The card's honest
  "not the A2A JSON-RPC protocol" declaration stays — we are aligning the
  **card format and signing**, not claiming protocol conformance we don't
  have (`protocolVersion` remains the discovery version).

## 4. Implementation plan

- `server/agent-card-signing.mjs` (pure, node:crypto only):
  - `jwsPayloadBytes(card)` — strip `signatures`, JCS-canonicalize;
  - `signCardJws({ card, privateKey, keyId, jku })` → `{ protected, signature }`;
  - `verifyCardJws({ card, publicKey, jws })` → boolean (never throws);
  - `publicKeyToJwk({ publicKey, keyId })` → `{ kty:"OKP", crv:"Ed25519", x, kid }`.
- `deploy/agent-card-key.mjs`: add `AGENT_CARD_JWKS_URL`.
- `deploy/agent-card-signed.mjs`: add `AGENT_CARD_JWS_SIGNATURES`
  (null when unsigned).
- `scripts/sign-agent-card.mjs`: after the house signature verifies against
  the pinned key, compute the JWS, verify it too (fail closed), write both
  into the generated module; unsigned path writes nulls for both.
- `deploy/agent-discovery.mjs`: attach `signatures` under the revision gate;
  serve `/.well-known/jwks.json` via `STATIC_DISCOVERY_DOCS`.
- Tests (never weakened, only added):
  - `tests/agent-card-signing.test.js`: JWS round-trip, tampered-card
    rejection, wrong-key rejection, protected-header contents
    (alg/kid/typ/jku), `verifyCardJws` never throws on garbage,
    `publicKeyToJwk` shape.
  - `tests/sign-agent-card-build.test.js`: signed build writes a JWS that
    verifies against the fixture key; unsigned build writes nulls.
  - `tests/agent-card-wellknown.test.js`: unsigned card has **no**
    `signatures` field; `/.well-known/jwks.json` serves the pinned key as
    JWKS; end-to-end verify of a fixture-signed card.

## 5. Out of scope / blockers

- Production signing still needs John's key custody (tap #59) — this PR only
  makes the mechanism A2A-shaped so the real key slots in later. No key,
  credential, account, or tap is required to build, test, or merge this.
- No changes to `protocolVersion`, transport claims, or the claims board.
