# Independent Node discovery signing

The Node server can serve a signed instance card and public JWKS for one explicit HTTPS origin. This does not configure HTTPS, create identities, grant Room access, install a native host or prove background execution. The server still binds only to loopback behind its existing same-host HTTPS proxy contract.

## Prepare a private runtime build

Commit the reviewed source first. Create a fresh runtime directory with an explicit build identifier:

```sh
node scripts/runtime-package.mjs create /absolute/source EXACT_40_CHAR_COMMIT /absolute/new-runtime --build-id INSTANCE_BUILD_ID
```

The default package operation remains a byte copy of committed source. The explicit build variant changes only the two release constants in `server/version.mjs`, records that derivation as `build` in the manifest, and binds its source revision to the selected commit. Verification checks the stamp and all packaged hashes. This proves content consistency, not trusted provenance or deployment approval. An unstamped build cannot start signed instance production.

## Keep signing custody outside the runtime

Use an operator-controlled Ed25519 key. The existing signing format uses a canonical base64 32-byte private seed and canonical base64 32-byte public key. Key creation, persistence, recovery and trust distribution remain operator responsibilities; this path does not auto-create custody or recover a lost key.

Place only the independently chosen public pin in a separate file:

```json
{"origin":"https://room.example","keyId":"instance-ed25519-v1","agentId":"my-room-instance","publicKey":"PUBLIC_KEY_FROM_OPERATOR_CUSTODY"}
```

The identity label is local metadata, not global identity. Obtain the public key from operator custody, not from an untrusted downloaded artifact. Keep the seed out of source, runtime packages, command arguments, environment dumps, public pin files and logs.

From the stamped runtime, pipe the seed directly from the operator-controlled offline signing process to:

```sh
node scripts/sign-instance-card.mjs /absolute/public-pin.json /absolute/new-public-card.json
```

The signer reads the seed only from standard input. It refuses an existing output, mismatched key pair, malformed pin or unstamped build; it writes only a public artifact. The runtime never reads a private signing key.

## Supply public material at startup

Configure both `ROOM_INSTANCE_CARD_PATH` and `ROOM_INSTANCE_CARD_PIN_PATH` as explicit absolute paths. They name the public artifact and independently trusted public pin. Missing halves, oversized or malformed files, symlinks, wrong origin, key, identity, signature or build fail closed. The artifact's own JWKS never establishes trust. Do not substitute an unsigned production opt-out.

Normal production prerequisites still apply: `NODE_ENV=production`, `ROOM_DEPLOYMENT=invite-only`, an exact HTTPS `ROOM_ORIGIN`, a provisioned nonempty persistent database at absolute `ROOM_DB`, and the existing same-host proxy. The proxy preserves the configured Host and overwrites `X-Real-IP` from its socket peer. Forwarded headers cannot select the signing identity or origin. This document does not authorize changing a real host or network.

Re-sign for each changed build and origin. Rotation requires an explicit operator decision about the new pin; neither the server nor an artifact can approve its own replacement trust anchor. Signed discovery proves possession of the pinned key, not trustworthiness, human identity, membership, OAuth registration or permission to act. Real HTTPS, remote clients and their pin/certificate trust still require qualification.
