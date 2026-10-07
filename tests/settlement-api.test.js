// Settlement API contract test (200-hard-tasks #19).
// Spins up the mock server (scripts/mock-settlement-api.mjs, implementing
// spec/settlement-api-v1.yaml) and drives the full fund -> accept ->
// release flow over HTTP with a real client, proving the contract:
// status codes, response shapes, idempotency-key replays, auth, and error
// codes. Credible regression: if the mock ever stopped verifying receipts
// before release, the bad-receipt case (422) would fail.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockServer, deriveKey } from "../scripts/mock-settlement-api.mjs";
import { issueSettlementReceipt, generateReceiptKeyPair } from "../server/settlement-receipt.mjs";
import { MONAD_MOCK_USDC } from "../server/settlement-adapter-monad.mjs";

let baseUrl;
let closeServer;
const AUTH = { Authorization: "Bearer test-gateway-secret" };

const post = (path, body, headers = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH, ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const get = (path, headers = {}) =>
  fetch(`${baseUrl}${path}`, { headers: { ...AUTH, ...headers } }).then(async (r) => ({ status: r.status, body: await r.json() }));

const ENVELOPE = {
  jobId: "job-api-1",
  payer: "buyer:demo",
  payee: "provider:mac-1",
  chainId: "monad-mock-10143",
  assetMint: MONAD_MOCK_USDC,
  amountRaw: "50000",
};

before(async () => {
  const s = await startMockServer(0);
  baseUrl = s.baseUrl;
  closeServer = s.close;
});

after(async () => {
  await closeServer();
});

describe("settlement API contract", () => {
  it("rejects unauthenticated calls with 401", async () => {
    const r = await fetch(`${baseUrl}/settlement/envelopes/x`);
    assert.equal(r.status, 401);
  });

  it("creates an envelope (201) and fetches it with escrow status", async () => {
    const created = await post("/settlement/envelopes", ENVELOPE);
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^env_[0-9a-f]{32}$/);
    const fetched = await get(`/settlement/envelopes/${created.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.jobId, "job-api-1");
    assert.equal(fetched.body.escrow, null); // not funded yet
  });

  it("rejects an invalid envelope with 400 ENVELOPE_INVALID", async () => {
    const r = await post("/settlement/envelopes", { ...ENVELOPE, assetMint: "0xnope" });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "ENVELOPE_INVALID");
  });

  it("runs fund -> accept -> release over HTTP", async () => {
    const created = await post("/settlement/envelopes", { ...ENVELOPE, jobId: "job-api-2" });
    const id = created.body.id;
    const fund = await post(`/settlement/envelopes/${id}/fund`, { amountRaw: "50000" });
    assert.equal(fund.status, 200);
    assert.equal(fund.body.status, "funded");
    const accept = await post(`/settlement/envelopes/${id}/accept`, {});
    assert.equal(accept.status, 200);
    assert.equal(accept.body.status, "accepted");

    const kp = generateReceiptKeyPair();
    const receipt = issueSettlementReceipt({
      seedHex: kp.seedHex, jobId: "job-api-2", envelopeId: id, providerId: "provider:mac-1",
      chainId: "monad-mock-10143", assetMint: MONAD_MOCK_USDC, amountRaw: "50000",
    });
    const release = await post(`/settlement/envelopes/${id}/release`, { receipt, pubkeyHex: kp.pubkeyHex });
    assert.equal(release.status, 200);
    assert.equal(release.body.status, "released");
  });

  it("release with a forged receipt -> 422 BAD_RECEIPT", async () => {
    const created = await post("/settlement/envelopes", { ...ENVELOPE, jobId: "job-api-3" });
    const id = created.body.id;
    await post(`/settlement/envelopes/${id}/fund`, { amountRaw: "50000" });
    await post(`/settlement/envelopes/${id}/accept`, {});
    const kp = generateReceiptKeyPair();
    const receipt = issueSettlementReceipt({
      seedHex: kp.seedHex, jobId: "job-api-3", envelopeId: id, providerId: "provider:mac-1",
      chainId: "monad-mock-10143", assetMint: MONAD_MOCK_USDC, amountRaw: "50000",
    });
    const forged = { ...receipt, signature: receipt.signature.slice(0, -1) + (receipt.signature.endsWith("0") ? "1" : "0") };
    const r = await post(`/settlement/envelopes/${id}/release`, { receipt: forged, pubkeyHex: kp.pubkeyHex });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, "BAD_RECEIPT");
  });

  it("idempotency-key replay on fund returns the cached result", async () => {
    const created = await post("/settlement/envelopes", { ...ENVELOPE, jobId: "job-api-4" });
    const id = created.body.id;
    const key = deriveKey({ scope: "fund", params: { envelopeId: id } });
    const first = await post(`/settlement/envelopes/${id}/fund`, { amountRaw: "50000" }, { "Idempotency-Key": key });
    assert.equal(first.status, 200);
    assert.equal(first.body.replayed, false);
    const second = await post(`/settlement/envelopes/${id}/fund`, { amountRaw: "50000" }, { "Idempotency-Key": key });
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.status, "funded");
  });

  it("refund after fund returns funds (200) and double refund -> 409", async () => {
    const created = await post("/settlement/envelopes", { ...ENVELOPE, jobId: "job-api-5" });
    const id = created.body.id;
    await post(`/settlement/envelopes/${id}/fund`, { amountRaw: "50000" });
    const refund = await post(`/settlement/envelopes/${id}/refund`, { reason: "buyer cancelled" });
    assert.equal(refund.status, 200);
    assert.equal(refund.body.status, "refunded");
    const again = await post(`/settlement/envelopes/${id}/refund`, { reason: "buyer cancelled again" });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "ADAPTER_ILLEGAL_TRANSITION");
  });

  it("receipts/verify verifies a good receipt and rejects a forged one", async () => {
    const kp = generateReceiptKeyPair();
    const receipt = issueSettlementReceipt({
      seedHex: kp.seedHex, jobId: "job-api-6", envelopeId: "env_x", providerId: "provider:mac-1",
      chainId: "monad-mock-10143", assetMint: MONAD_MOCK_USDC, amountRaw: "50000",
    });
    const good = await post("/settlement/receipts/verify", { receipt, pubkeyHex: kp.pubkeyHex, jobId: "job-api-6", amountRaw: "50000" });
    assert.equal(good.status, 200);
    assert.equal(good.body.ok, true);
    const bad = await post("/settlement/receipts/verify", { receipt, pubkeyHex: kp.pubkeyHex, amountRaw: "1" });
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.code, "amount_mismatch");
  });

  it("ledger totals reflect funded and released jobs", async () => {
    const r = await get("/settlement/ledger/epochs/mock-epoch/totals");
    assert.equal(r.status, 200);
    // job-api-2: deposit 50000 + claim 50000; job-api-3: deposit 50000 (release rejected, funds stay);
    // job-api-4: deposit 50000 (idempotent replay did not double-book); job-api-5: deposit 50000 + refund 50000
    assert.equal(r.body.deposit, "200000");
    assert.equal(r.body.claim, "50000");
    assert.equal(r.body.refund, "50000");
  });

  it("unknown envelope -> 404 NOT_FOUND", async () => {
    const r = await get("/settlement/envelopes/env_00000000000000000000000000000000");
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "NOT_FOUND");
  });
});
