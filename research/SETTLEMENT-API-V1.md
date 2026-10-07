# Settlement API Surface Design (200-hard-tasks #19)

Internal API the gateway/compute layer calls to fund jobs, check status,
and release payment. OpenAPI 3.1: `spec/settlement-api-v1.yaml` (9
endpoints). Mock server: `scripts/mock-settlement-api.mjs`. Contract test:
`tests/settlement-api.test.js` (10 tests, all passing against the mock).

## Endpoints

| method | path | purpose |
|---|---|---|
| POST | /settlement/envelopes | build + validate an envelope |
| GET | /settlement/envelopes/{id} | envelope + escrow status |
| POST | /settlement/envelopes/{id}/fund | fund escrow (idempotent) |
| POST | /settlement/envelopes/{id}/accept | provider accepts |
| POST | /settlement/envelopes/{id}/release | release on verified receipt (idempotent) |
| POST | /settlement/envelopes/{id}/refund | refund to payer (idempotent) |
| POST | /settlement/envelopes/{id}/dispute | open a dispute |
| POST | /settlement/receipts/verify | verify a settlement receipt |
| GET | /settlement/ledger/epochs/{id}/totals | per-kind ledger totals |

## Auth model

Service-to-service inside the trust boundary: `Authorization: Bearer
<gateway-identity-secret>` on every call; the bearer identifies the calling
gateway for audit. 401 on missing/empty bearer. No end-user credentials are
accepted — this API is never exposed to providers or buyers directly; the
gateway mediates.

## Idempotency

POST fund/release/refund accept an `Idempotency-Key` header
(`idem_v1_<scope>_<hash>`, task #3). Replays return the cached result with
`replayed: true`; concurrent duplicates get 409 `IDEM_CONFLICT`. The mock
proves the ledger is not double-booked on replay (contract test asserts
deposit totals).

## Error codes

| code | HTTP | meaning |
|---|---|---|
| ENVELOPE_INVALID | 400 | envelope failed validation (wrong asset/chain/amount, bad shape) |
| IDEM_BAD_KEY | 400 | malformed idempotency key |
| ADAPTER_RECEIPT_REQUIRED | 400 | release without receipt evidence |
| BAD_RECEIPT | 422 | settlement receipt failed verification |
| ADAPTER_WRONG_AMOUNT | 422 | amountRaw disagrees with the envelope |
| NOT_FOUND | 404 | unknown envelope / epoch / escrow |
| IDEM_CONFLICT | 409 | idempotency key already in progress |
| ADAPTER_ILLEGAL_TRANSITION | 409 | transition not allowed from current state |
| UNAUTHORIZED | 401 | missing/empty bearer |

## Mock server

`node scripts/mock-settlement-api.mjs [port]` — implements the full spec
against the in-memory modules (envelope validator, Monad mock adapter,
idempotency store, receipt verifier, SQLite ledger). Also importable:
`startMockServer(port)` for tests. The mock is the executable contract:
any gateway client developed against it works against the real service as
long as both honor the spec.

## Client contract (proven by test)

1. Create envelope → 201 with `id`.
2. Fund with `Idempotency-Key` → 200 `funded`; replay → 200 `replayed: true`.
3. Accept → 200 `accepted`.
4. Release with provider receipt + pubkey → 200 `released`; forged receipt → 422 `BAD_RECEIPT`.
5. Refund → 200 `refunded`; second refund → 409 `ADAPTER_ILLEGAL_TRANSITION`.
6. Receipts/verify → `{ ok: true }` or `{ ok: false, code, reason }`.
7. Ledger totals reflect exactly the funded/released/refunded jobs.
