// x402 demo contract tests (200-hard-tasks #9).
// Contract guarded: the mock provider serves ONLY with a valid signed
// payment authorization — no payment -> 402, bad payment -> 402 with the
// specific rejection reason, good payment -> 200 exactly once per nonce.
// Credible regression: if nonce-reuse were ever allowed, the same payment
// could buy unlimited requests; the replay test pins single-use.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startDemoServer, verifyPayment, PRICE } from "../scripts/x402-demo-server.mjs";
import { authorizedFetch, generatePayer, signAuthorization } from "../scripts/x402-demo-client.mjs";

let baseUrl;
let closeServer;

before(async () => {
  const s = await startDemoServer(0);
  baseUrl = s.baseUrl;
  closeServer = s.close;
});

after(async () => {
  await closeServer();
});

const nowSec = () => Math.floor(Date.now() / 1000);

describe("x402 payment-gated API", () => {
  it("serves nothing without payment: 402 + requirements", async () => {
    const r = await fetch(`${baseUrl}/inference?prompt=hi`);
    assert.equal(r.status, 402);
    const body = await r.json();
    assert.equal(body.accepts[0].amountRaw, PRICE.amountRaw);
    assert.equal(body.accepts[0].payTo, PRICE.payTo);
  });

  it("full loop: 402 -> sign -> retry -> 200", async () => {
    const payer = generatePayer();
    const r = await authorizedFetch(baseUrl, "/inference?prompt=hello", payer);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.result, /inference result/);
    assert.equal(body.paid, PRICE.amountRaw);
  });

  it("rejects underpayment with 402 underpaid", async () => {
    const payer = generatePayer();
    const auth = { payTo: PRICE.payTo, asset: PRICE.asset, chainId: PRICE.chainId, amountRaw: "1", nonce: "u1", expiresAt: nowSec() + 300, payerPubkeyHex: payer.pubkeyHex };
    const v = verifyPayment(Buffer.from(JSON.stringify(auth), "utf8").toString("base64url"));
    assert.equal(v.ok, false);
    assert.equal(v.reason, "underpaid");
  });

  it("rejects expired authorizations", () => {
    const payer = generatePayer();
    const payment = signAuthorization(payer, { nonce: "e1", expiresAt: nowSec() - 1 });
    const v = verifyPayment(payment);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "expired");
  });

  it("rejects nonce reuse (each payment buys exactly one request)", async () => {
    const payer = generatePayer();
    const nonce = `replay-${nowSec()}`;
    const payment = signAuthorization(payer, { nonce, expiresAt: nowSec() + 300 });
    const first = await fetch(`${baseUrl}/inference`, { headers: { "X-Payment": payment } });
    assert.equal(first.status, 200);
    const second = await fetch(`${baseUrl}/inference`, { headers: { "X-Payment": payment } });
    assert.equal(second.status, 402);
    assert.equal((await second.json()).error, "nonce-reused-or-missing");
  });

  it("rejects wrong payee and bad signatures", () => {
    const payer = generatePayer();
    const good = signAuthorization(payer, { nonce: "w1", expiresAt: nowSec() + 300 });
    const decoded = JSON.parse(Buffer.from(good, "base64url").toString("utf8"));
    const wrongPayee = Buffer.from(JSON.stringify({ ...decoded, payTo: "0xAttacker" }), "utf8").toString("base64url");
    assert.equal(verifyPayment(wrongPayee).reason, "wrong-payee");
    const evil = generatePayer();
    const forged = signAuthorization(evil, { nonce: "w2", expiresAt: nowSec() + 300 });
    const forgedDecoded = JSON.parse(Buffer.from(forged, "base64url").toString("utf8"));
    const mismatched = Buffer.from(JSON.stringify({ ...forgedDecoded, payerPubkeyHex: payer.pubkeyHex }), "utf8").toString("base64url");
    assert.equal(verifyPayment(mismatched).reason, "bad-signature");
  });

  it("rejects malformed payment headers", () => {
    assert.equal(verifyPayment("!!!not-base64!!!").reason, "malformed-payment");
  });
});
