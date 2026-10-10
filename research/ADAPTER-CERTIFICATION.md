# Adapter Certification Procedure (200-hard-tasks #15)

How to certify a new settlement chain adapter (Solana, Monad, future EVM
legs) against the shared conformance suite. Both local adapters
(`monad-mock`, `solana-mock`) pass 100% — a new leg must do the same before
it settles real jobs.

## 1. Implement the interface

Create `server/settlement-adapter-<leg>.mjs` exporting a factory that returns
a `SettlementAdapter` (from `server/settlement-adapter.mjs`) configured with:

- `name` — leg identifier, e.g. `base-mainnet`
- `chainId` — registered in `settlement-envelope.mjs` `CHAIN_IDS`
- `assetMint` + `assetDecimals` — registered via `registerAsset()`

The base class already implements the lifecycle
(fund → accept → release; fund → refund; fund → accept → cancel → refund),
replay protection, illegal-transition guards, and the append-only event log.
A leg only supplies chain-specific call recording (see `mockEscrowCall` /
`mockProgramCall` as the replacement points for real contract calls).

## 2. Wire the harness

Add a runner next to `tests/settlement-conformance.test.js`:

```js
import { certifyAdapter } from "./settlement-conformance-harness.test.js";
certifyAdapter("base-mainnet", createBaseAdapter, baseEnvelope);
```

`makeEnvelope(suffix)` must build a valid envelope for the leg via
`createEnvelope()` with distinct `jobId`s per suffix (duplicate funds across
cases would collide on envelope id).

## 3. Run

```sh
TMPDIR=$PWD/.tmp node --test tests/settlement-conformance.test.js
```

## 4. Pass criteria (100% required)

| Case | What fails it |
|---|---|
| fund | rejects a valid envelope, or emits anything other than `funded` |
| accept | does not move funded → accepted |
| release | does not move accepted → released with receipt; event trail ≠ [funded, accepted, released] |
| refund | does not reach refunded with an audit trail |
| duplicate-event | replayed fund creates a second escrow or a second `funded` event |
| wrong-amount | tampered amount vs the agreed amount settles |
| wrong-asset | unregistered mint on the leg settles |
| wrong-chain | cross-leg envelope settles |
| transitions | release without receipt, or fund → release skip |

## 5. Record the certification

Post the harness output (all cases green) with the adapter PR. The adapter
merges only after 100% pass; the merge train treats a red conformance case
as a hard gate.
