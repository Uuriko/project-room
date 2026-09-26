# TraceSeal interop

**One line:** TraceSeal proves the code ran; Project Room receipts prove the
work was done.

## What TraceSeal is

TraceSeal (<https://traceseal.io/spec>, verifier at
<https://github.com/traceseal/traceseal-verify>) produces signed
**Execution Receipts** — self-contained JSON documents proving, for one
agent execution:

- **what code ran** — manifest hash over every source file,
- **who authorized it** — publisher's Ed25519 signature in a transparency log,
- **what sandbox it ran in** — hash of the kernel-namespace configuration,
- **what it produced** — SHA-256 of inputs and outputs (hashes, not values —
  privacy preserving),
- **who vouches for it** — operator's Ed25519 signature over everything above.

Third parties verify with one command (`pip install traceseal-verify` /
`traceseal-verify receipt.json`), offline, with no access to the operator's
machine. Canonical-JSON signing, hashes-not-content, Ed25519 — the same
discipline as our standard.

## What a Project Room receipt is

A Receipt Standard v1 attestation (`spec/receipt-standard-v1.md`) is a signed
statement by an agent *about work*: what it touched (`surface`), what it
**claims** (`declaration`), what was **mechanically measured**
(`observations`), and what was explicitly **not** verified (`limitations`,
mandatory non-empty). It binds an identity to a statement so the statement
can be checked, disputed, and held against the issuer later. It does not
answer *is it true?* — that is the job of reviewers and tests.

## How they compose

An execution proof is the strongest possible *observation*. A TraceSeal
Execution Receipt plugs into a v1 receipt in two places:

| Standard field | Mapping |
|---|---|
| `surface.resources[]` | `{ "kind": "traceseal-execution-receipt", "ref": "<receipt URI or hash>", "sha256": "<receipt bytes hash>" }` — the sealed execution becomes a referenced resource of the work. |
| `observations[]` | `{ "kind": "traceseal-execution", "detail": "execution receipt <hash> verified; manifest <hash>; inputs/outputs <hashes>" }` — a mechanically-reproducible fact a third party can re-verify offline. |

The stack reads bottom-up: TraceSeal seals *the run* (code, sandbox,
inputs/outputs); our receipt wraps the run in *judgment* — the summary, the
claims the agent is willing to be held to, and the priced ignorance of what
wasn't checked. Execution receipts can't carry "I didn't test this on mobile";
work receipts can't prove which binary ran. Together they cover both.

## What this is not

- **Not an integration.** No code dependency, no shared key ceremony, no
  vendored verifier. This document is a mapping between two independently
  verifiable formats.
- **Not a claim about TraceSeal.** Project Room does not verify TraceSeal
  receipts itself; any emitter that references one is making a checkable
  claim that a reviewer can re-verify with `traceseal-verify`.
- **Not exclusive.** The same `observations` slot accepts any
  mechanically-reproducible evidence (test runs, byte counts, SLSA
  provenance). TraceSeal is the execution-proof-shaped one.

Honest scope: this mapping is written from TraceSeal's public spec and
verifier as of 2026-09-25. No joint testing has been done; the first emitter
to use it should publish both receipts side by side so a third party can
verify the chain end to end.
