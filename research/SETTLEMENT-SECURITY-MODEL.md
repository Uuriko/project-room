# Settlement Security Model (200-hard-tasks #10)

Threat analysis for the Dasha settlement flow: envelope → adapter legs
(Solana/Monad) → CCTP v2 funding → escrow lifecycle → receipts → ledger →
reconciliation. Covers the components built in tasks 1–9, 11–14, 19–20.

## System boundary & trust zones

```
ZONE A (trusted)                    ZONE B (semi-trusted)              ZONE C (untrusted)
gateway / settlement API            provider agents                    chains, bridges, users' wallets
- envelope builder                  - run jobs, sign receipts          - Solana / Monad / CCTP
- adapter legs                      - hold provider keys               - Circle attestation
- idempotency store                 - submit results                   - public mempool / RPC
- ledger + reconciler               - economic actors: may cheat
- tripwire evaluator
- gateway identity secret
```

Trust boundaries:
1. **A↔B:** the settlement API (`spec/settlement-api-v1.yaml`). Providers
   authenticate as themselves; the API never accepts provider-signed
   *instructions* about other parties' money — only receipts about their
   own work, verified against expected (jobId, amount, envelopeId, chain).
2. **A↔C:** adapter legs. Chain data is adversarial until finalized:
   reorgs, fake RPC responses, attestation delays. Nothing is booked from
   unfinalized chain data.
3. **Inside A:** the gateway identity secret is the crown jewel — it can
   call fund/release/refund. Compromise = full treasury control.

## STRIDE per component

### Settlement envelope (task #1)
| threat | analysis | mitigation |
|---|---|---|
| Tampering | envelope fields (amount, asset, chain) altered in flight | envelope is validated at every leg (`assertEnvelope`); any mutation invalidates downstream checks |
| Spoofing | attacker crafts an envelope naming their wallet as payee | envelopes are built server-side from the job record, never from provider input |
| Repudiation | payer denies agreeing to the amount | envelope id + job id are logged with the gateway identity; receipt chain links back |
| Info disclosure | envelope leaks payer/payee linkage | envelopes are internal; only receipts (no payer identity) leave zone A |
| DoS | envelope spam | envelope creation is gateway-authenticated and rate-limited |
| Elevation | — | n/a (data structure, no privileges) |

### Adapter legs (tasks #6, #7)
| threat | analysis | mitigation |
|---|---|---|
| Tampering | fake "funded" events from a malicious RPC | adapter confirms funding against finalized chain state, not mempool; mock legs are test-only and clearly labeled |
| Repudiation | provider claims they were never paid | release requires a provider-signed receipt (task #4); receipt is the non-repudiation token |
| Illegal transition | release before fund, double release | state machine (task #5) rejects illegal transitions; idempotency (task #3) makes replays safe |
| DoS | adapter RPC stalls block the gateway | per-leg timeouts + circuit breaker; a stalled leg fails the job, not the gateway |

### CCTP v2 funding (task #8)
| threat | analysis | mitigation |
|---|---|---|
| Tampering | hook metadata altered to redirect funds | hook data is part of the signed CCTP message; the hook validates asset + 99% floor |
| Spoofing | fake attestation | only Circle-signed attestations accepted; never trust a self-reported "attested" |
| DoS | attestation delayed indefinitely | poller hard timeout (3600s) → operator alert; fast-transfer path for time-sensitive funding |
| Elevation | attacker calls the hook directly | hook accepts calls only from the message transmitter |

### Receipts (task #4)
| threat | analysis | mitigation |
|---|---|---|
| Spoofing | forged provider signature | Ed25519 verify against the provider's registered pubkey; 422 on failure |
| Replay | receipt reused for a second job | receipt binds (jobId, envelopeId, nonce); verifier checks expected job/amount; nonce registry rejects reuse |
| Tampering | amount altered post-signing | signature covers the canonical JSON including amount; any edit breaks verify |
| Repudiation | provider denies issuing | signature is non-repudiable; receipts are journaled |

### Idempotency (task #3)
| threat | analysis | mitigation |
|---|---|---|
| Replay | duplicate fund/release calls | idempotency keys make replays return cached results; concurrent duplicates get 409 |
| Key collision | two different operations share a key | keys embed scope + params hash (`deriveKey`); scope mismatch is a 400 |

### Ledger + reconciliation (tasks #12, #14)
| threat | analysis | mitigation |
|---|---|---|
| Tampering | ledger edited to hide theft | ledger is append-only; closed epochs immutable; corrections are new adjusting entries |
| Repudiation | operator denies a booking | every reconciliation attempt journaled; epoch close requires clean reconcile |
| Info disclosure | ledger leaks flow volumes | ledger is internal; totals endpoints are gateway-authenticated |

### Reputation / canary / metering (tasks #21–24)
| threat | analysis | mitigation |
|---|---|---|
| Spoofing | provider inflates canary pass rate | canary jobs are indistinguishable from real jobs; sampling is server-side random |
| Tampering | provider under-reports tokens | metering uses the vendored BPE tokenizer (task #22), never provider-reported counts |
| Gaming | provider optimizes for the metric | reputation weights multiple signals (canary² dominant); disputes feed back in |

### Tripwires (task #20)
| threat | analysis | mitigation |
|---|---|---|
| Tampering | attacker disables a tripwire | tripwire rules are versioned config; changes are audited; evaluator fails closed on bad config |
| DoS | alert fatigue | rules have severity tiers; only critical pages |

## Key management requirements

| key | custody | rotation | loss impact |
|---|---|---|---|
| gateway identity secret | HSM / managed secret store; never in code, logs, or chat | 90 days or on personnel change | full treasury control — rotate immediately, freeze funding |
| provider receipt keys | provider-held; pubkey registered at onboarding | provider-initiated; old pubkey revoked on rotation | provider can forge their own receipts (only affects their jobs) |
| escrow program authority | multisig (2-of-3: gateway, operator, cold backup) | n/a (multisig membership change by vote) | single key loss does not move funds |
| ledger DB encryption key | managed secret store; separate from app secrets | 180 days | confidentiality of flow data |
| CCTP hook admin | multisig, same as escrow authority | n/a | hook logic change redirects future funding |

Rules: no key in git (pre-commit scan), no key in chat/room posts, no key
in error messages. Receipt signing keys are Ed25519; chain keys follow each
chain's standard.

## Pre-launch audit checklist

- [ ] Envelope validator: fuzz with malformed/edge-case envelopes (wrong chain, zero amount, unknown asset) — all rejected.
- [ ] Adapter legs: illegal-transition matrix tested (release-before-fund, double-release, refund-after-release).
- [ ] Receipt verifier: forged signature, wrong amount, wrong job, replayed nonce — all rejected.
- [ ] Idempotency: concurrent duplicate fund with same key → one booking + 409s; different params same key → 400.
- [ ] CCTP hook: called directly (not via transmitter) → revert; underfunded below 99% → revert; credits amountReceived not expected.
- [ ] Ledger: close epoch with mismatches → blocked; closed epoch → append rejected; conservation invariant holds on mainnet-fork data.
- [ ] Reorg handling: chain reorg deeper than finality → escrow state unchanged; no double-credit.
- [ ] Key inventory: every key in the table above exists in the secret store; none in git history (`git log -S` scan).
- [ ] Tripwires: each of the 12 rules fires on synthetic data; evaluator fails closed on corrupt config.
- [ ] Mock legs disabled: no `*-mock-*` chain id accepted in production config.
- [ ] Incident runbook: key compromise, attestation stall, hook exploit — each has a named owner and a first action.
- [ ] External review: at least one independent reviewer (not the author) has walked the STRIDE table and signed off.

## Residual risks (accepted, monitored)

1. **Circle attestation trust** — CCTP finality depends on Circle; a
   compromised attester could mint unbacked USDC on Monad. Monitored via
   attestation latency tripwires; capped per-epoch funding limits bound the
   blast radius.
2. **Fast-transfer LP risk** — the LP fronts funds; if the attestation
   later fails, the LP (not us) eats it — but our hook must handle the
   no-mint case (funds never arrive; job stays unfunded, never half-funded).
3. **Provider key theft** — a stolen provider key forges receipts for that
   provider's jobs only; bounded by per-job amounts and the dispute window.
