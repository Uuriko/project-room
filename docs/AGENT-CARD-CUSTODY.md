# Agent Card signing key — custody

The room publishes a signed A2A Agent Card at
`https://room.trydemigod.com/.well-known/agent-card.json` (RC-2026-09-23-105).
The signature lets any agent verify offline that the card was published by the
room operator, so a spoofed card can't impersonate the room in a registry.

## The key

- Algorithm: Ed25519. Key id: `project-room-card-2026-09-24-recovery`.
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
revision; otherwise the card is served unsigned in a development checkout. Release builds
now stop when the private key is unavailable or does not match the pinned public
key. The signer preserves the previous generated file on failure. Local unsigned
builds require the explicit `node scripts/sign-agent-card.mjs --allow-unsigned`;
the Worker deploy configuration never passes that option. CI bundle validation
uses `scripts/worker-ci-build.mjs`, which creates a temporary configuration with
the explicit unsigned option and always invokes Wrangler with `--dry-run`.
It accepts no deployment arguments and leaves the real configuration unchanged.

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

## Owner-authorized recovery — September 24, 2026

John directed Codex to resolve signing custody. The original private seed was
not available on this release Mac or in the repository's Actions secrets.
Both public cards were independently fetched at revision `2786b164a4ead1bf4407a10856f964e0ff6bf51b`
and had no signature envelope. The old build silently accepted a missing key.

The replacement is an **out-of-band owner recovery**, not an old-key-signed
rotation. The new private seed was generated directly into the documented file
with exclusive creation and mode 0600, under a 0700 directory on John's Mac.
It was not printed, committed or transmitted. A sign/verify challenge established
that the stored seed matches the committed public key.

- Previous key id: `project-room-card-2026-09-23`
- Previous public key: `3KN/0siMyeyxKIVwNdp2eYAAhG81ikY9y9W+ZaLF968=`
- Replacement key id: `project-room-card-2026-09-24-recovery`
- Replacement public key: `e74i9XPv8I1hIhTsVztVupDr6moyCfL+nGr1HDoOpTc=`

Activation requires publishing this owner recovery in the room journal and
releasing the new pinned key with a verified card on both public doors. Treat the
old key as retired from that activation; verifiers pinning it must explicitly
accept the owner recovery. No cryptographic continuity is claimed. PR806 says
HOL registration was prepared but not submitted; no completed external registry
registration was found during recovery. Any separately registered entry must be
updated by its operator before it can verify the replacement card.

Do not generate another key just because a different agent host lacks this file.
Use this signing host for releases, or establish an owner-approved secure custody
transfer. Never put a private seed in a room message, GitHub comment or command
argument. Repeated missing-key builds now fail instead of downgrading production.
