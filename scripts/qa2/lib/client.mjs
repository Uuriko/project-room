// Shared QA HTTP client. Identity mints solve the same proof as src/client.js:
// sha256(`${bucket}:${trim(displayName)}:${nonce}`) must start with
// IDENTITY_POW_BITS/4 zero hex digits, bucket = floor(now / window).
// A presented proof is accepted before the anonymous free-mint quota, and a
// 429 is retried from Retry-After so a later script on the same server can
// still mint after the per-address minute cap.
import { createHash } from "node:crypto";

const POW_BITS = 12;
const POW_WINDOW_MS = 10 * 60 * 1000;
const MINT_PATHS = new Set(["/api/agent-identities", "/api/identity-create"]);

export function solveIdentityMintProof(displayName, now = Date.now(), bits = POW_BITS) {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  const bucket = Math.floor(now / POW_WINDOW_MS);
  const prefix = "0".repeat(bits / 4);
  for (let i = 0; i < 1_000_000; i++) {
    const nonce = i.toString(36);
    const hex = createHash("sha256").update(`${bucket}:${name}:${nonce}`).digest("hex");
    if (hex.startsWith(prefix)) return nonce;
  }
  throw new Error("proof search exhausted");
}

const pathnameOf = path => {
  if (path.startsWith("http://") || path.startsWith("https://")) return new URL(path).pathname;
  return path.split("?")[0];
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createQaClient({ origin, userAgent }) {
  let rateLimited = 0;

  async function request(method, path, {
    token,
    body,
    accept = "application/json",
    headers: extra = {},
    foldSse = true,
  } = {}) {
    const started = performance.now();
    const mint = method === "POST" && MINT_PATHS.has(pathnameOf(path));
    let payload = body;
    if (mint && payload && typeof payload === "object" && !Array.isArray(payload)
      && typeof payload.displayName === "string" && !Object.hasOwn(payload, "proof")) {
      payload = { ...payload, proof: solveIdentityMintProof(payload.displayName) };
    }
    let proofRetried = false;
    const url = path.startsWith("http://") || path.startsWith("https://") ? path : origin + path;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const headers = { "user-agent": userAgent, accept, ...extra };
        if (payload !== undefined) {
          headers["content-type"] = "application/json";
          headers.origin = origin;
        }
        if (token) headers.authorization = `Bearer ${token}`;
        const response = await fetch(url, {
          method,
          headers,
          body: payload === undefined ? undefined : JSON.stringify(payload),
        });
        if (response.status === 429 && attempt < 5) {
          rateLimited += 1;
          const retryAfter = Number(response.headers.get("retry-after"));
          const reset = Number(response.headers.get("x-ratelimit-reset"));
          let waitMs = 61_000;
          if (Number.isFinite(retryAfter) && retryAfter >= 0) waitMs = retryAfter * 1000;
          else if (Number.isFinite(reset)) waitMs = reset * 1000 - Date.now() + 250;
          await response.arrayBuffer();
          await sleep(Math.min(65_000, Math.max(250, waitMs)));
          continue;
        }
        if (response.status === 428 && mint && !proofRetried && payload && typeof payload.displayName === "string") {
          const text = await response.text();
          let json = null;
          try { json = JSON.parse(text); } catch { /* keep text */ }
          const bits = json?.proof?.bits;
          if (Number.isInteger(bits) && bits >= 4 && bits % 4 === 0) {
            payload = { ...payload, proof: solveIdentityMintProof(payload.displayName, Date.now(), bits) };
            proofRetried = true;
            continue;
          }
          return { status: response.status, json, text, headers: response.headers, ms: Math.round(performance.now() - started) };
        }
        let text = await response.text();
        if (foldSse && /^(event|data):/.test(text)) {
          text = text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5)).join("\n");
        }
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON stays in text */ }
        return { status: response.status, json, text, headers: response.headers, ms: Math.round(performance.now() - started) };
      }
      return { status: 0, json: null, text: "no response", headers: new Headers(), ms: Math.round(performance.now() - started) };
    } catch (error) {
      return { status: 0, json: null, text: String(error), headers: new Headers(), ms: Math.round(performance.now() - started) };
    }
  }

  return {
    request,
    get rateLimited() { return rateLimited; },
  };
}
