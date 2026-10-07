# Dispute Evidence Standard (hard task 107)

What counts as evidence in a bounty dispute. A dispute without a standard
is a shouting match; with one, the arbiter checks boxes. Validator:
`scripts/exchange/evidence-validator.mjs`; 10 sample bundles exercised in
`tests/exchange-evidence-validator.test.js`.

## The bundle

A dispute evidence bundle is one JSON object:

```json
{
  "bundleVersion": "dispute-evidence/1",
  "bountyId": "b1",
  "submittedBy": "member-or-identity-id",
  "submittedAt": "2026-10-07T12:00:00.000Z",
  "claim": "work.completed | work.not_completed | payment.owed | payment.not_owed",
  "items": [
    {
      "kind": "artifact-link | test-report | message-ref | commit-ref | screenshot | log-excerpt | attestation",
      "uri": "https://… | room://…",
      "sha256": "… (required for artifact-link, log-excerpt)",
      "capturedAt": "2026-10-06T…Z",
      "note": "what this proves, in one sentence"
    }
  ],
  "signature": { "signer": "identity-id", "sig": "hex-ed25519" }
}
```

## Rules

1. **Formats.** `items` is a non-empty array; every item has a `kind` from
   the closed vocabulary above and a one-sentence `note`. `artifact-link`
   and `log-excerpt` items must carry a `sha256` of the bytes they point to
   (content-addressed: the bytes can't be swapped after submission).
2. **Timestamps.** `submittedAt` and every `capturedAt` must be valid
   ISO-8601 UTC, not in the future, and `capturedAt` must not predate the
   bounty's `funded` event (evidence from before the bounty existed is
   inadmissible — it proves nothing about this bounty).
3. **Verification.** The bundle must carry an Ed25519 `signature` over the
   canonical JSON of the bundle minus the signature, by `submittedBy`'s
   identity key. Unsigned bundles are inadmissible. (In the prototype the
   validator checks shape + timestamps + hash presence; signature
   verification plugs in the room's identity keys at integration.)
4. **Relevance.** At least one item must directly support the `claim`
   (the validator checks kind-to-claim mapping: e.g. `work.completed`
   needs an `artifact-link` or `test-report`; `payment.owed` needs a
   `message-ref` or `attestation` recording the agreement).
5. **Freshness.** Evidence captured more than 30 days before submission is
   flagged `stale` (admissible but discounted — the validator warns, the
   arbiter decides).

## Kind-to-claim map

| claim | required item kinds (≥1) |
|---|---|
| work.completed | artifact-link, test-report |
| work.not_completed | log-excerpt, message-ref |
| payment.owed | message-ref, attestation |
| payment.not_owed | artifact-link, log-excerpt, attestation |

## The 10 sample bundles

In `tests/exchange-evidence-validator.test.js`: valid completion bundle,
valid non-completion bundle, missing signature, future timestamp,
evidence predating funding, wrong hash (tampered bytes), empty items,
unknown kind, claim without a supporting item kind, stale evidence (warns
but passes). The validator accepts 2, rejects 7, warns on 1.
