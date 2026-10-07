// x402-style payment-gated API demo: the client side (200-hard-tasks #9).
// Demonstrates the full 402 -> pay -> retry loop:
//   1. GET /inference without payment -> 402 + requirements
//   2. build + Ed25519-sign the payment authorization
//   3. GET /inference with X-Payment -> 200 + result
// Also importable: { authorizedFetch } for tests.
// Usage: node scripts/x402-demo-client.mjs <baseUrl>
import { generateKeyPairSync, sign, createPrivateKey } from "node:crypto";
import { canonicalAuth, PRICE } from "./x402-demo-server.mjs";

export function generatePayer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  return { pubkeyHex: pubDer.subarray(pubDer.length - 32).toString("hex"), seedHex: seed.toString("hex") };
}

function importSeed(seedHex) {
  const header = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({ key: Buffer.concat([header, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
}

export function signAuthorization(payer, { nonce, expiresAt }) {
  const auth = {
    payTo: PRICE.payTo, asset: PRICE.asset, chainId: PRICE.chainId,
    amountRaw: PRICE.amountRaw, nonce, expiresAt, payerPubkeyHex: payer.pubkeyHex,
  };
  const signatureHex = sign(null, Buffer.from(canonicalAuth(auth), "utf8"), importSeed(payer.seedHex)).toString("hex");
  return Buffer.from(JSON.stringify({ ...auth, signatureHex }), "utf8").toString("base64url");
}

// GET with automatic 402 -> pay -> retry. Returns the final response.
export async function authorizedFetch(baseUrl, path, payer) {
  const first = await fetch(`${baseUrl}${path}`);
  if (first.status !== 402) return first;
  const req402 = await first.json();
  if (req402.error) throw new Error(`payment rejected: ${req402.error}`);
  const nowSec = Math.floor(Date.now() / 1000);
  const payment = signAuthorization(payer, {
    nonce: `n-${nowSec}-${Math.floor(Math.random() * 1e9)}`,
    expiresAt: nowSec + PRICE.validForSec,
  });
  return fetch(`${baseUrl}${path}`, { headers: { "X-Payment": payment } });
}

const isCli = process.argv[1] && process.argv[1].endsWith("x402-demo-client.mjs");
if (isCli) {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error("usage: x402-demo-client.mjs <baseUrl>");
    process.exit(2);
  }
  const payer = generatePayer();
  const res = await authorizedFetch(baseUrl, "/inference?prompt=hello", payer);
  console.log(`status: ${res.status}`);
  console.log(JSON.stringify(await res.json(), null, 1));
}
