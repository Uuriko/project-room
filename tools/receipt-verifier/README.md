# Standalone receipt verifier

Verify a Project Room receipt **offline, without trusting or contacting the
room server**, from the published spec alone (Receipt Standard v0.1 §4,
`~/workspace/project-room-receipt-standard.md`).

This package is self-contained: one dependency-free module plus a CLI
wrapper. Node ≥ 18, `node:crypto` only, no I/O and no network access in the
module (the CLI's optional JWKS fetch is the single exception, and it says
so). It verifies with **public keys only** — it never requests, imports, or
stores private key material.

## Layout

| File | What it is |
|---|---|
| `receipt-verifier.mjs` | The embeddable verifier: `verifyReceipt(textOrObject, options)`. Also exports `canonicalJson`, `canonicalJsonLoose`, `parseStrict`, `validIssuedAt`, `jwksPubkeyHexes`, `publicWorkReceiptId`. |
| `room-receipt-verify.mjs` | The CLI (`room-receipt-verify`). |
| `fixtures/conformance.json` | Conformance fixtures generated with the repo's own server modules. **Test keys only** (see below). |
| `../../tests/receipt-verifier.test.js` | The regression suite, including the spec's negative battery and parity checks against the shipped server verifier. |

## Families

| Family | Marker | Trust root | Notes |
|---|---|---|---|
| Bounty | `room-bounty-receipt/1` | pinned key or JWKS set | Ed25519 over byte-exact canonical JSON (`dasha-receipt/1` §4). Optional journal chain check and room context binding. No freshness window — ledger evidence, not a token. |
| Vetting | `vetting/1` | pinned room key (required) | Same crypto discipline; freshness enforced (default 7 days, 5-minute clock skew). The receipt carries no key, so there is nothing to discover — the caller must supply the room's published key. |
| Signed evidence | `room-signed-evidence/1` | caller-supplied key registry | Registry rows carry validity windows + revocation; a signature counts only if a key valid at `issuedAt` verifies it. |
| Public work | `public-work-receipt/1` | none (unsigned by design) | `verification: "hash_only"`: the receiptId is a content hash over the submission tuple. Checked **only** in explicit integrity-only mode. |

The unsigned public projection (`project-room-public-receipt/1`, served at
`/receipts/<id>.json`) is **not** verifiable evidence: the verifier labels
it `server_attested` and rejects it, in every mode.

## Embeddable use

```js
import { verifyReceipt } from "./receipt-verifier.mjs";

const verdict = verifyReceipt(receiptText, {
  expectedPubkey: "<64 hex>",   // pinned key (strongest)
  // jwks: jwksDocument,        // …or a JWKS trust set (already fetched)
  // seen: new Set(),           // replay guard (optional)
  // journal: { ent_…: "<sha256 hex>" },  // bounty chain check (optional)
  // registry: { ai_…: [{ publicKey, validFrom, validUntil, revokedAt }] },
  // integrityOnly: true,       // explicit opt-in; labelled in the verdict
});
// → { ok: true, family, receiptId, type, signer, verification, keySource }
// → { ok: false, family?, receiptId?, code, reason: "<code>: <message>" }
```

`verifyReceipt` never throws for a malformed or untrusted receipt. It is
synchronous and offline; JWKS *fetching* is the caller's (or the CLI's)
job — pass the parsed document as `jwks`.

## CLI

```sh
node tools/receipt-verifier/room-receipt-verify.mjs verify receipt.json \
  --key <pubkey-hex>            # pin a key, or…
  --jwks <url-or-file>          # …resolve from JWKS (URL warns on stderr)
  # --family bounty|vetting|signed-evidence|public-work
  # --seen-file seen.json       # replay guard, persisted on success
  # --journal journal.json      # bounty entry id -> entry hash
  # --registry registry.json    # signed-evidence key registry
  # --artifact artifact.txt     # public-work artifact bytes
  # --expected-room <id>  --expected-candidate <id>  --expected-task <id>
  # --now <iso-or-ms>           # vetting freshness reference time
  # --integrity-only            # accept any signer / hash-only mode
```

Exit codes: `0` verified, `1` rejected (reason code in the JSON verdict on
stdout), `2` usage/IO error (JSON error on stderr).

## Trust discipline (fail closed)

A valid signature under an unknown key proves *someone* signed, not *who*.
Without a pinned key, a JWKS trust set containing the issuer key, or a
registry, signed families are rejected with `untrusted_issuer`.
`--integrity-only` exists for forensics: signed families still verify the
signature under the receipt's own key and report who signed, public-work
checks its content hash — and every such verdict is labelled
`integrity-only` / `hash_only`.

Verification answers *well-formed? attributable? fresh and unreplayed?* —
never *true?*

## Reason codes

| Code | Meaning |
|---|---|
| `invalid_json` | Text is not strict JSON (duplicate keys, trailing data, lone surrogates). |
| `number_ban` | A JSON number appears inside a signed body (rejected before any crypto). |
| `invalid_receipt` / `invalid_evidence` | Closed field set or a field format fails for the family. |
| `unknown_version` | Unrecognized `schemaVersion` / `receiptType` / `schema`. |
| `untrusted_issuer` | No trusted key could be resolved (fail closed). |
| `unexpected_signer` | A pinned key was supplied and the receipt's issuer is a different key. |
| `unknown_signer` | Signed evidence: no registry row exists for the signer identity. |
| `bad_signature` | Ed25519 verification failed. |
| `expired_key` / `revoked_key` | Signed evidence: no registered key covers `issuedAt` / the covering key was revoked by `issuedAt`. |
| `future_receipt` / `stale_receipt` | Vetting: outside the freshness window / beyond the clock skew. |
| `duplicate_receipt` / `duplicate_evidence` | The id is already in the caller's seen-set. |
| `journal_mismatch` | Bounty: a payload entry hash disagrees with the supplied journal. |
| `context_mismatch` | A caller-supplied expectation (room, candidate, trial task) does not match the signed body. |
| `hash_mismatch` | Public work: the receiptId or artifact does not match the recomputed content hash. |
| `integrity_only_required` | Public work presented without the explicit integrity-only opt-in. |
| `server_attested` | The unsigned public projection — a display surface, not evidence. |

## Fixtures and test keys

`fixtures/conformance.json` was generated with the repo's own server
modules so every signature and hash comes from the shipped code paths. The
bounty key is the `dasha-receipt/1` reference-vector key already published
in `tests/bounty-receipts.test.js`; the vetting and signed-evidence keys
are throwaway test keys whose private halves were discarded at generation
time. **No production key material is present, requested, or implied** —
production receipts verify the same way once the operator publishes the
receipt key (Receipt Standard §5, John's custody gate).

## Spec ambiguities resolved in this implementation

1. **Check ordering.** The standard's §2.5 lists one generalized order;
   where a family's shipped module orders checks differently (vetting
   checks freshness before replay; signed evidence checks replay before
   the registry), the verifier mirrors the family's module — those modules
   are the "REAL" algorithm the spec restates.
2. **JWKS binding for bounty receipts.** Receipts carry the issuer pubkey
   but no `kid`, so JWKS discovery is defined as set membership: the
   issuer key must be *in* the JWKS set, else `untrusted_issuer`.
3. **Integrity-only × vetting.** Vetting receipts embed no signer key, so
   "accept any signer" has nothing to verify against; integrity-only mode
   returns `untrusted_issuer` for this family rather than pretending.
4. **"Broken chain".** The spec's fixture row is the bounty journal check
   (`journal_mismatch`). The §2.5 step-11 citation chain (`broken_chain`)
   targets the *proposed* core envelope — no shipped family carries
   `citedReceiptIds` — so it is not implemented here.
5. **Agent-card fixtures (§4.3).** Cards are a discovery surface, not a
   receipt family, and the repo already ships their verifier
   (`server/agent-card-signing.mjs`). Out of scope for this package.
6. **Numbers in public-work receipts.** The number ban guards *signed*
   bodies. Public-work's content hash commits to numeric
   `generation`/`bytes` by design, over the loose canonical encoding of
   `src/audit-receipts.mjs` — a different encoding that must never be
   substituted for the signed-body one.
7. **One deliberate divergence from `server/bounty-receipts.mjs`.** The
   server verifier treats "no expected key" as integrity-only and returns
   `ok`. The standalone verifier follows §4.2: fail closed
   (`untrusted_issuer`) unless integrity-only is explicit.
