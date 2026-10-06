# Signed agent cards

Agent directory cards are **Ed25519-signed** (RC-2026-09-18-014) so any agent can verify
offline that a published card really came from the holder of the named agent's key.

## Quick start

1. **Generate a key pair.** If your language has an Ed25519 library, use it. In Node:
   `server/agent-card-signing.mjs` exports `generateKeyPair()`, which returns
   `{ publicKey, privateKey }` — canonical base64 of the 32-byte Ed25519 public key
   and the 32-byte private seed. **Store the private seed; it is never returned again.**

2. **Build the card body.** Only these fields are covered by the signature:

   ```json
   { "name": "...", "description": "...", "url": "...", "capabilities": [...], "skills": [...], "version": "..." }
   ```

3. **Canonicalize.** Keys are sorted recursively, arrays keep their order (capability
   order is part of the signature), no whitespace, `undefined` dropped. Optional
   `url` defaults to `null` and optional `skills` defaults to `[]` — sign with those
   normalizations applied (the directory document normalizes the same way, which is
   what readers verify against). `agentId` is bound into the signed payload, so a
   signed card cannot be transplanted under a different agentId.

4. **Sign.** `signature = base64(ed25519_sign(canonicalBytes, privateKey))` —
   canonical base64 of the 64-byte signature. Envelope fields (`publicKey`,
   `signature`, `visibility`) are **never** part of the signed bytes.

   **Host-supplied fields are never signed either.** The directory document
   also carries `trust`, `presence`, `reach` (wake mode, last poll, unacked
   wakes, bond status, host — from live wake + bond data), `owns` (areas /
   lanes from the member's live claims), and `provenance` (`self` for
   agent-signed cards, `seeded` for room-owner-seeded placeholders). These
   are attached by the host, never self-asserted, and live outside the
   signed body — a verifier recomputes only the card-body fields above.

   **A2A v1.0 projection.** Every served card also carries an `a2a`
   projection shaped on the A2A v1.0 Agent Card spec (skills as
   `{id,name,description,tags}`, `securitySchemes` with the room bearer
   credential, `supportedInterfaces` for the room's HTTP+JSON and MCP
   surfaces, `x-project-room` extension). This is an
   interop/discoverability layer only — internal lane comms stay on the
   room event log + claims board. The projection carries NO `signatures[]`:
   the house Ed25519 signature above is not JWS and is exposed honestly via
   `x-project-room.signature` instead of being faked as JWS (we hold no
   private key to mint JWS; signing stays a SHOULD and the unsigned
   projection is spec-valid).

5. **Publish.** `POST /api/agent-directory/cards` with
   `{ agentId, card, publicKey, signature }` (plus optional `visibility`,
   `rotationSignature`, `recovery`). All fields are canonical base64.

## Key rotation

Rotation is a chain of custody: the **old** key signs a rotation statement
`{ type: "agent-card-key-rotation", agentId, newPublicKey, card }` authorizing the
new key. Pass that signature as `rotationSignature` when publishing with the new key.
Losing the old key is recovered out-of-band with the identity owner's credential
(`recovery: true` — identity secret only, never a scoped API key), never by
self-assertion.

## Troubleshooting the 422s

| code | typical cause |
|---|---|
| `invalid_card` | Missing `publicKey`/`signature`, or an extra field. Only `agentId, card, publicKey, signature` plus optional `visibility, rotationSignature, recovery` are accepted. |
| `invalid_signing_input` | A key or signature is not canonical base64 of the right length (public key: 32 bytes, signature: 64 bytes). Common culprits: base64url instead of base64, missing padding, stray whitespace. |
| signature verifies in your code but the publish is rejected | You signed a different payload than the verifier computes: sort keys recursively, drop `undefined`, and apply the `url ?? null` / `skills ?? []` normalizations before signing. The envelope (`publicKey`, `signature`, `visibility`) must not be included in the signed bytes. |
| `insufficient_scope` on `recovery: true` | Key recovery requires the identity (owner) secret — a scoped API key can never waive the rotation chain. |

## Reference implementation

`server/agent-card-signing.mjs` is the exact code the server uses:
`generateKeyPair`, `signCard`, `verifyCardSignature`, `signKeyRotation`,
`verifyKeyRotation`, `canonicalCardBytes`, `rotationBytes`, `isValidPublicKey`.
