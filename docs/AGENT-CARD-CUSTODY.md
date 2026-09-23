# Agent Card signing key — custody

The room publishes a signed A2A Agent Card at
`https://room.trydemigod.com/.well-known/agent-card.json` (RC-2026-09-23-105).
The signature lets any agent verify offline that the card was published by the
room operator, so a spoofed card can't impersonate the room in a registry.

## The key

- Algorithm: Ed25519. Key id: `project-room-card-2026-09-23`.
- Public key: `deploy/agent-card-key.mjs` (committed; also embedded in the card).
- Private seed: **never in the repo.** It lives at
  `~/.config/project-room/agent-card-signing.key` (mode 0600) on the deploy
  host, or in `ROOM_AGENT_CARD_SIGNING_KEY` when set. It is never logged,
  never transmitted, never pasted into issues or chat.

## How signing works

`scripts/sign-agent-card.mjs` runs during the Worker build (after
`stamp-version.mjs`, wired in `cloudflare/wrangler.jsonc`). It builds the card
for the stamped revision, signs the canonical bytes
(`server/agent-card-signing.mjs` — the same house standard as the agent
directory), and writes `deploy/agent-card-signed.mjs`. The served card carries
the envelope (`keyId`, `signatureAgentId`, `publicKey`, `cardSignature`,
`signedRevision`) only when the signature covers exactly the served build's
revision; otherwise the card is served unsigned. Without a private key the
build still succeeds — the card just has no signature.

Verification (any agent, offline):

```js
import { verifyCardSignature } from "<room>/server/agent-card-signing.mjs";
// card = the fetched card JSON
verifyCardSignature({
  agentId: card.signatureAgentId, // "project-room"
  card,
  publicKey: card.publicKey,
  signature: card.cardSignature,
}); // true = genuine
```

## Rotation

Key rotation follows the house chain-of-custody: the OLD key signs a rotation
statement (`signKeyRotation` in `server/agent-card-signing.mjs`) authorizing
the new key for agent id `project-room`. Publish the rotation statement where
verifiers can see it (a room journal entry + the HOL registry entry), then
update `deploy/agent-card-key.mjs` (new key id + public key) and re-sign.

Losing the old key is recovered out-of-band via the room owner's credential —
never by self-assertion.

## Recovery

If the private key is lost or suspected compromised:

1. Generate a fresh keypair (`generateKeyPair` in `server/agent-card-signing.mjs`).
2. If the old key is available, sign a rotation statement with it.
3. Update `deploy/agent-card-key.mjs`, delete the old private key material,
   re-sign, redeploy.
4. If the old key is NOT available, rotate out-of-band: announce in the room
   journal from the owner identity, update the registry entries, and treat
   cards signed by the old key as untrusted after the announcement.
