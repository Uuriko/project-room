# CCTP v2 Funding Metadata Model (200-hard-tasks #8)

How cross-chain funding (Solana → Monad USDC via CCTP v2) is quoted,
initiated, tracked, and hooked into the settlement escrow. Simulator:
`scripts/simulate-cctp.mjs` (mocked attestations, virtual clock).
Tests: `tests/cctp-sim.test.js` (9 tests).

## Roles

- **Source (Solana, domain 5):** payer burns USDC via `depositForBurn`.
- **Attester (Circle):** signs an attestation that the burn happened.
- **Destination (Monad, domain 10143):** anyone submits
  `receiveMessage(message, attestation)`; USDC is minted to the recipient.
- **Hook:** CCTP v2 messages can carry hook data — on mint, the destination
  calls the hook contract, which funds the settlement escrow automatically.

## Fast-Transfer-in / Standard-out asymmetry

| | fast | standard |
|---|---|---|
| mechanism | liquidity provider fronts the funds, settled against the later attestation | wait for Circle attestation finality |
| latency | 1–4s | 600–1200s |
| fee | 10 bps (0.10%) | 1 bp (0.01%) |
| when to use | per-job funding where the provider must start now | batched/treasury refills where 15 min is fine |

The funding path uses **fast in** (a job's escrow must fund before the
provider starts work) and the treasury uses **standard out** (periodic
rebalancing can wait). Never the reverse: paying 10 bps on slow treasury
moves is waste; waiting 15 min per job is a UX failure.

## Deposit → attestation polling flow

```
gateway                    solana                    circle              monad
   | quote(amount, mode)      |                          |                  |
   | -> { fee, net, eta }     |                          |                  |
   | depositForBurn(amount,   |                          |                  |
   |   destDomain=10143,      |                          |                  |
   |   mintRecipient=hook,    |                          |                  |
   |   hookData)  ----------> | burn USDC, emit          |                  |
   |                          | DepositForBurn ----------|--------------->  |
   | poll attestation(txHash) |    (attestation service watches)           |
   |   every 5s, backoff      |                          |                  |
   |   on timeout: retry with |                          |                  |
   |   fresh request (burn    |                          |                  |
   |   is still valid)        |                          |                  |
   | <------- attestation ----|                          |                  |
   | receiveMessage(message,  |                          |                  |
   |   attestation) ----------------------------------------------> mint  |
   |                                                         USDC to hook  |
   |                                                     hook: fund escrow |
   |                                                     (jobId, envId)    |
```

Polling: 5s interval, exponential backoff on transient timeouts (the burn
is still valid — only the poller gave up), hard timeout 3600s → operator
alert. Re-polling after mint is a replay, not a second mint (the simulator
pins this).

## Hook-handler contract pseudocode

```solidity
// Destination-chain hook called by CCTP v2 MessageTransmitter on mint.
contract FundingEscrowHook {
    // hookData (ABI-encoded in the CCTP message):
    //   bytes32 jobId; bytes32 envelopeId; uint256 expectedNetRaw; address asset;
    function handleReceive(
        bytes32 sourceDomain, bytes32 sender,
        bytes calldata hookData, uint256 amountReceived
    ) external onlyMessageTransmitter {
        (bytes32 jobId, bytes32 envelopeId, uint256 expectedNetRaw, address asset)
            = abi.decode(hookData, (bytes32, bytes32, uint256, address));
        require(asset == USDC, "wrong asset");
        // Fast-transfer fee tolerance: accept within 1% of quoted net.
        require(amountReceived >= expectedNetRaw * 99 / 100, "underfunded");
        // Credit the EXACT received amount (never the expected) to the escrow.
        escrows[envelopeId].fund(jobId, amountReceived);
        emit EscrowFunded(envelopeId, jobId, amountReceived);
    }
}
```

Key metadata rules:
- The hook credits `amountReceived`, not `expectedNetRaw` — the envelope's
  amount check (task #1) runs against what actually arrived.
- `expectedNetRaw` is a *floor with tolerance* (99%), not an exact match —
  fee drift between quote and execution must not brick funding.
- The hook is the mint recipient, so funds never sit in an EOA between mint
  and escrow (no intermediate custody).

## Failure / retry table

| failure | detection | retry | simulator fault |
|---|---|---|---|
| attestation timeout | poller exceeds interval × attempts | fresh attestation request, exponential backoff; burn still valid | `attestationTimeoutAt` (one-shot, transient) |
| attestation never arrives | hard timeout 3600s | operator alert; manual re-request or refund on source | `neverAttests` → `poller-timeout` |
| insufficient fee (fast) | LP rejects / quote stale | re-quote at current fee; abort if fee > cap | `insufficientFee` |
| hook reverts | mint succeeds, hook call fails | funds sit in hook contract; operator sweeps to escrow manually; fix hook, replay | `hookReverts` |
| message already consumed | receiveMessage reverts "already spent" | treat as success (idempotent); reconcile | re-poll after mint → `replayed` |
| wrong destination domain | quote validation | fail before burn; no funds move | (quote-time check) |
| underfunded (fee drift) | hook's 99% floor check | top-up transfer for the shortfall; escrow funds partially | (hook pseudocode) |

## What the simulator demonstrates

`createTransfer({ mode: "fast"|"standard", faults })` + `runToCompletion()`:
fast completes in ≤4 virtual seconds with hook metadata bound to
(jobId, envelopeId, expectedNet); standard in 600–1200s; every failure in
the table is reachable and classified; `pollWithRetry` recovers from the
transient timeout. Run: `node --input-type=module -e "import('./scripts/simulate-cctp.mjs')..."`.
