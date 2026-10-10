// x402-style payment-gated API demo: the provider side (200-hard-tasks #9).
// A mock provider that serves /inference only with a valid signed payment
// authorization. Flow (mirrors x402, with Ed25519 instead of secp256k1 —
// see research/X402-DEMO.md for the mapping):
//   1. client GET /inference (no payment) -> 402 + payment requirements
//   2. client signs an authorization over (payTo, asset, amount, nonce, expiry)
//   3. client retries with X-Payment: <base64url auth>
//   4. server verifies signature, amount, expiry, nonce-reuse -> 200 + result
// Usage: node scripts/x402-demo-server.mjs [port] (prints base URL + demo keypair)
import { createServer } from "node:http";
import { sign, verify, generateKeyPairSync } from "node:crypto";

export const PROVIDER_KEYPAIR = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  return { pubkeyHex: pubDer.subarray(pubDer.length - 32).toString("hex"), seedHex: seed.toString("hex") };
})();

export const PRICE = Object.freeze({
  asset: "USDC",
  chainId: "monad-mock-10143",
  amountRaw: "25000", // per request, raw units
  payTo: "0xProviderTreasury",
  validForSec: 300,
});

const seenNonces = new Set();

export function paymentRequirements() {
  return {
    code: 402,
    accepts: [{ ...PRICE, nonce: null, scheme: "x402-demo/ed25519", note: "sign canonical JSON, send as X-Payment" }],
  };
}

export function canonicalAuth(a) {
  return JSON.stringify({
    payTo: a.payTo, asset: a.asset, chainId: a.chainId,
    amountRaw: a.amountRaw, nonce: a.nonce, expiresAt: a.expiresAt,
  });
}

export function verifyPayment(authB64, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  let auth;
  try {
    auth = JSON.parse(Buffer.from(authB64, "base64url").toString("utf8"));
  } catch {
    return fail("malformed-payment");
  }
  if (auth.payTo !== PRICE.payTo) return fail("wrong-payee");
  if (auth.asset !== PRICE.asset || auth.chainId !== PRICE.chainId) return fail("wrong-asset");
  if (BigInt(auth.amountRaw || "0") < BigInt(PRICE.amountRaw)) return fail("underpaid");
  if (!auth.nonce || seenNonces.has(auth.nonce)) return fail("nonce-reused-or-missing");
  if ((auth.expiresAt || 0) <= nowSec) return fail("expired");
  const payerKey = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(auth.payerPubkeyHex || "", "hex")]);
  let sigOk = false;
  try {
    sigOk = verify(null, Buffer.from(canonicalAuth(auth), "utf8"), { key: payerKey, format: "der", type: "spki" }, Buffer.from(auth.signatureHex, "hex"));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail("bad-signature");
  seenNonces.add(auth.nonce);
  return { ok: true, payer: auth.payerPubkeyHex };
}

export function startDemoServer(port = 0) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/inference") {
      res.writeHead(404).end("not found");
      return;
    }
    const payment = req.headers["x-payment"];
    if (!payment) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify(paymentRequirements()));
      return;
    }
    const v = verifyPayment(payment);
    if (!v.ok) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 402, error: v.reason, accepts: paymentRequirements().accepts }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: `inference result for prompt ${JSON.stringify(url.searchParams.get("prompt") || "")}`, paid: PRICE.amountRaw, payer: v.payer.slice(0, 12) + "…" }));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const isCli = process.argv[1] && process.argv[1].endsWith("x402-demo-server.mjs");
if (isCli) {
  const port = parseInt(process.argv[2] || "0", 10);
  startDemoServer(port).then(({ baseUrl }) => {
    console.log(`x402 demo provider at ${baseUrl}`);
    console.log(`price: ${PRICE.amountRaw} ${PRICE.asset} per /inference -> ${PRICE.payTo}`);
  });
}
