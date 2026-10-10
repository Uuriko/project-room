// Mock settlement API server (200-hard-tasks #19).
// Implements spec/settlement-api-v1.yaml against the in-memory settlement
// modules (envelope, adapter, idempotency, receipt verifier, ledger).
// Auth: any non-empty `Authorization: Bearer <secret>` (the mock trusts the
// internal network; the real service validates the gateway identity secret).
// POST fund/release/refund honor the Idempotency-Key header.
// Usage: node scripts/mock-settlement-api.mjs [port]  (default 0 = random;
// prints the base URL). Import { startMockServer } to embed in tests.
import { createServer } from "node:http";
import { createEnvelope } from "../server/settlement-envelope.mjs";
import { createMonadAdapter } from "../server/settlement-adapter-monad.mjs";
import { createDedupStore, executeOnce, deriveKey, IdempotencyError } from "../server/idempotency.mjs";
import { verifySettlementReceipt } from "../server/settlement-receipt.mjs";
import { openLedger } from "../server/settlement-ledger.mjs";

const adapter = createMonadAdapter({ name: "mock-api-leg" });
const idem = createDedupStore();
const ledger = openLedger();
const envelopes = new Map(); // envelope id -> envelope

ledger.openEpoch("mock-epoch");

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const err = (res, status, code, message) => json(res, status, { code, message });

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });

const escrowState = (id, replayed = false) => {
  const rec = adapter.get(id);
  if (!rec) return null;
  return { envelopeId: id, status: rec.status, replayed };
};

async function idempotent(key, fn) {
  if (!key) return { ...(await fn()), replayed: false };
  const r = await executeOnce(idem, key, fn);
  return { ...r.result, replayed: r.replayed };
}

export function startMockServer(port = 0) {
  const server = createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer ") || auth.length < 8) {
        return err(res, 401, "UNAUTHORIZED", "missing or empty bearer token");
      }
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname.replace(/^\/v1/, "");
      const body = req.method === "POST" ? await readBody(req).catch(() => null) : {};
      if (body === null) return err(res, 400, "ENVELOPE_INVALID", "request body is not JSON");
      const idemKey = req.headers["idempotency-key"] || null;

      // POST /settlement/envelopes
      if (req.method === "POST" && path === "/settlement/envelopes") {
        try {
          const r = await idempotent(idemKey, async () => {
            const env = createEnvelope(body);
            envelopes.set(env.id, env);
            return { envelope: env };
          });
          return json(res, 201, { ...r.envelope, replayed: r.replayed || undefined });
        } catch (e) {
          return err(res, 400, "ENVELOPE_INVALID", e.message);
        }
      }

      // GET /settlement/envelopes/{id}
      let m = path.match(/^\/settlement\/envelopes\/([^/]+)$/);
      if (req.method === "GET" && m) {
        const env = envelopes.get(m[1]);
        if (!env) return err(res, 404, "NOT_FOUND", "envelope not found");
        return json(res, 200, { ...env, escrow: escrowState(env.id) });
      }

      // POST /settlement/envelopes/{id}/fund
      m = path.match(/^\/settlement\/envelopes\/([^/]+)\/fund$/);
      if (req.method === "POST" && m) {
        const env = envelopes.get(m[1]);
        if (!env) return err(res, 404, "NOT_FOUND", "envelope not found");
        try {
          const r = await idempotent(idemKey, async () => {
            const rec = adapter.fund(env, body.amountRaw);
            ledger.record({ epochId: "mock-epoch", kind: "deposit", jobId: env.jobId, chainId: env.chain.id, assetMint: env.chain.asset.mint, amountRaw: env.chain.amountRaw, txRef: `mock-fund-${env.id.slice(0, 8)}` });
            return { escrow: escrowState(env.id), duplicate: rec.duplicate || false };
          });
          return json(res, 200, { envelopeId: env.id, status: r.escrow.status, replayed: r.replayed || r.duplicate || false });
        } catch (e) {
          return mapAdapterError(res, e);
        }
      }

      // POST /settlement/envelopes/{id}/accept
      m = path.match(/^\/settlement\/envelopes\/([^/]+)\/accept$/);
      if (req.method === "POST" && m) {
        try {
          const rec = adapter.accept(m[1]);
          return json(res, 200, escrowState(m[1]));
        } catch (e) {
          return mapAdapterError(res, e);
        }
      }

      // POST /settlement/envelopes/{id}/release
      m = path.match(/^\/settlement\/envelopes\/([^/]+)\/release$/);
      if (req.method === "POST" && m) {
        const env = envelopes.get(m[1]);
        if (!env) return err(res, 404, "NOT_FOUND", "envelope not found");
        if (!body.receipt || !body.pubkeyHex) {
          return err(res, 400, "BAD_RECEIPT", "receipt and pubkeyHex required");
        }
        const v = verifySettlementReceipt(body.receipt, {
          expectedPubkey: body.pubkeyHex,
          jobId: env.jobId,
          amountRaw: env.chain.amountRaw,
          chainId: env.chain.id,
        });
        if (!v.ok) return err(res, 422, "BAD_RECEIPT", `${v.code}: ${v.reason}`);
        try {
          const r = await idempotent(idemKey, async () => {
            adapter.release(env.id, body.receipt);
            ledger.record({ epochId: "mock-epoch", kind: "claim", jobId: env.jobId, chainId: env.chain.id, assetMint: env.chain.asset.mint, amountRaw: env.chain.amountRaw, txRef: `mock-release-${env.id.slice(0, 8)}` });
            return { escrow: escrowState(env.id) };
          });
          return json(res, 200, { ...r.escrow, replayed: r.replayed || false });
        } catch (e) {
          return mapAdapterError(res, e);
        }
      }

      // POST /settlement/envelopes/{id}/refund
      m = path.match(/^\/settlement\/envelopes\/([^/]+)\/refund$/);
      if (req.method === "POST" && m) {
        const env = envelopes.get(m[1]);
        if (!env) return err(res, 404, "NOT_FOUND", "envelope not found");
        if (!body.reason) return err(res, 400, "ENVELOPE_INVALID", "reason required");
        try {
          const r = await idempotent(idemKey, async () => {
            adapter.refund(env.id, body.reason);
            ledger.record({ epochId: "mock-epoch", kind: "refund", jobId: env.jobId, chainId: env.chain.id, assetMint: env.chain.asset.mint, amountRaw: env.chain.amountRaw, txRef: `mock-refund-${env.id.slice(0, 8)}` });
            return { escrow: escrowState(env.id) };
          });
          return json(res, 200, { ...r.escrow, replayed: r.replayed || false });
        } catch (e) {
          return mapAdapterError(res, e);
        }
      }

      // POST /settlement/envelopes/{id}/dispute
      m = path.match(/^\/settlement\/envelopes\/([^/]+)\/dispute$/);
      if (req.method === "POST" && m) {
        if (!body.reason) return err(res, 400, "ENVELOPE_INVALID", "reason required");
        try {
          adapter.dispute(m[1], body.evidence || {});
          return json(res, 200, escrowState(m[1]));
        } catch (e) {
          return mapAdapterError(res, e);
        }
      }

      // POST /settlement/receipts/verify
      if (req.method === "POST" && path === "/settlement/receipts/verify") {
        if (!body.receipt || !body.pubkeyHex) return err(res, 400, "BAD_RECEIPT", "receipt and pubkeyHex required");
        const v = verifySettlementReceipt(body.receipt, {
          expectedPubkey: body.pubkeyHex,
          jobId: body.jobId ?? null,
          amountRaw: body.amountRaw ?? null,
          chainId: body.chainId ?? null,
        });
        return json(res, 200, v.ok ? { ok: true } : { ok: false, code: v.code, reason: v.reason });
      }

      // GET /settlement/ledger/epochs/{epochId}/totals
      m = path.match(/^\/settlement\/ledger\/epochs\/([^/]+)\/totals$/);
      if (req.method === "GET" && m) {
        try {
          return json(res, 200, ledger.totals(m[1]));
        } catch {
          return err(res, 404, "NOT_FOUND", "epoch not found");
        }
      }

      return err(res, 404, "NOT_FOUND", "unknown route");
    } catch (e) {
      if (e instanceof IdempotencyError) {
        if (e.code === "IDEM_CONFLICT") return err(res, 409, "IDEM_CONFLICT", e.message);
        return err(res, 400, "IDEM_BAD_KEY", e.message);
      }
      if (e.code === "ENVELOPE_INVALID") return err(res, 400, "ENVELOPE_INVALID", e.message);
      return err(res, 500, "INTERNAL", e.message);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}/v1`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function mapAdapterError(res, e) {
  const code = e.code || "INTERNAL";
  if (code === "ADAPTER_UNKNOWN_ID") return err(res, 404, "NOT_FOUND", e.message);
  if (code === "ADAPTER_ILLEGAL_TRANSITION") return err(res, 409, "ADAPTER_ILLEGAL_TRANSITION", e.message);
  if (code === "ADAPTER_RECEIPT_REQUIRED") return err(res, 400, "ADAPTER_RECEIPT_REQUIRED", e.message);
  if (code === "ENVELOPE_INVALID" || code === "ADAPTER_WRONG_AMOUNT") return err(res, 422, "ADAPTER_WRONG_AMOUNT", e.message);
  return err(res, 500, "INTERNAL", e.message);
}

export { deriveKey };

const isCli = process.argv[1] && process.argv[1].endsWith("mock-settlement-api.mjs");
if (isCli) {
  const port = parseInt(process.argv[2] || "0", 10);
  startMockServer(port).then(({ baseUrl }) => {
    console.log(`mock settlement API at ${baseUrl}`);
  });
}
