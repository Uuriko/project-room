# D5 — Dead-code reachability review (guild-19)

Every exported validator in the slice was grepped for callers across
`server/`, `src/`, `scripts/`, `tests/`. Result: **one** dormant export, **zero**
dead validators.

## Dormant: `createDownloadTracker` (`server/attachments.mjs:40`)

- **Evidence:** `grep -rn "createDownloadTracker" server/ tests/ scripts/ src/`
  hits exactly two files: its definition in `server/attachments.mjs` and
  `tests/attachments.test.js`. No production caller exists — no route, no
  store, no manager constructs one.
- **What it is:** a download tracker factory (`store` Map + `maxMessageBytes`)
  for attachment downloads. The room attachment download path serves bytes
  via `json()` (base64 in the response body), which never consults a tracker.
- **Verdict:** dormant API, not a bug. Kept (not deleted) — removing an export
  is a behavior-adjacent change outside this slice's verification mandate;
  the finding is filed here for the owning lane. If no consumer appears,
  delete it and its tests together.

## Not dead (verified live callers)

| Export | Callers |
|---|---|
| `validateClaimText` | `server/http.mjs` (`/api/claims/validate`), `server/discoverability.mjs` |
| `extractClaimBlock`, `parseClaimFields`, `validateClaimFields` | sub-functions of `validateClaimText`; exported for tests — part of the module's pinned surface |
| `isReservedRoleName`, `assertNotReservedRoleName`, `assertAdmissibleMemberName` | admission paths (identity mint, invite redeem, share-link join, access requests) |
| `validatePluginManifest` | `server/agent-plugin-routes.mjs` |
| `buildPluginManifest` | `server/agent-plugin-store.mjs` |
| `assertKnownEvents` | subscription creation inside `agent-webhook-subscriptions.mjs` |
| `verifySignature`/`signPayload` | webhook delivery verification |
| `validateMagicReturnTo` | `server/routes/auth.mjs` |
| `buildMagicLinkUrl` | `server/resend-mailer.mjs` |
| `isGuestInviteCode` | guest invite redemption |
| `validateAttachment` | `room-attachment-bytes.mjs` `checkedFile()` |
| `parseIpv4`/`parseIpv6`/`isBlockedIp` | `server/web-fetch.mjs`, `server/outbound-webhooks.mjs` |
| `scannableOfEnvelope`, `runImportGuards`, `replayImportedNotification` | `server/inbox.mjs` import funnel |
| `columnExists`/`tableExists` | analytics readers |

## Note on sub-function exports
`claim-validate.mjs` exports its internals (`extractClaimBlock`,
`parseClaimFields`, `validateClaimFields`) purely for test pinning — the
M1 mutants were killed through `tests/claim-validate.test.js` hitting these
directly. That's intentional, not dead code.
