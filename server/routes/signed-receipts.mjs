// Signed bounty receipt body read path (proof layer S4; design B3 §1).
//
//   GET  /receipts/signed/{receiptId}
//   HEAD /receipts/signed/{receiptId}
//
// Handler order is normative (B3 §1.2): shape ⇒ journal-stamp lookup ⇒
// THE GATE (lotReceiptVisible, unmodified, plus the receipt's own
// operator-unpublish leg; no second opt-in check exists in this file)
// ⇒ body resolution ⇒ stamp/body cross-check ⇒ serve. Every failure
// converges on the identical 404 (not_found / "Not found"), so the
// face is never an existence oracle: opted-out, never-recorded,
// unpublished, nonexistent, malformed, body-absent, and cross-check
// failures are indistinguishable in status, code, and message.
//
// A 200 carries the body exactly as issued, Cache-Control: no-store
// (the representation is toggle-controlled, like its sibling receipt
// faces), a strong ETag over canonicalJson(body), and X-Robots-Tag:
// noindex. If-None-Match is honoured ONLY after the gate passes.
import { createHash } from "node:crypto";
import { canonicalJson } from "../bounty-receipts.mjs";
import { lotReceiptVisible } from "../public-visibility.mjs";
import { isUnpublished } from "../legal-store.mjs";
import { signedReceiptBodyById, signedReceiptStamp } from "../signed-receipt-read.mjs";

// The receiptId shape validator's own pattern (bounty-receipts.mjs).
const RECEIPT_ID_PATTERN = /^room-bounty-receipt:(el|bl|at|pr|rf):[0-9a-f]{32}$/;

export function signedReceiptRoute(ctx) {
  ctx.rate(`receipts:${ctx.remoteAddress}`, 120);
  const receiptId = ctx.params?.receiptId;
  const notFound = () => ctx.reject(404, "not_found", "Not found");
  // 1. Shape.
  if (typeof receiptId !== "string" || !RECEIPT_ID_PATTERN.test(receiptId)) notFound();
  const store = ctx.store;
  // 2. Journal-stamp lookup.
  const stamp = signedReceiptStamp(store, receiptId);
  if (!stamp) notFound();
  // 3. THE GATE — the existing single definition, unmodified, plus the
  //    receipt's own unpublish leg. Do not write a second opt-in check.
  if (!lotReceiptVisible(store.db, { id: stamp.lotId, roomId: stamp.roomId })) notFound();
  if (isUnpublished(store.db, "receipt", receiptId)) notFound();
  // 4. Body resolution + stamp/body cross-check (inside the resolver).
  const resolved = signedReceiptBodyById(store, receiptId);
  if (!resolved) notFound();
  const body = resolved.body;
  // 5. Serve.
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  const etag = `"sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}"`;
  ctx.res.setHeader("Cache-Control", "no-store");
  ctx.res.setHeader("X-Robots-Tag", "noindex");
  ctx.res.setHeader("ETag", etag);
  // Conditional requests are honoured only here — after the gate.
  if (ctx.req.headers?.["if-none-match"] === etag) {
    ctx.res.writeHead(304);
    return ctx.res.end();
  }
  ctx.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length });
  return ctx.res.end(ctx.req.method === "HEAD" ? undefined : bytes);
}

export const SIGNED_RECEIPT_ROUTES = Object.freeze(["GET", "HEAD"].map(method => Object.freeze({
  id: `signed-receipt-${method.toLowerCase()}`,
  method,
  path: "/receipts/signed/{receiptId}",
  auth: "none",
  capability: null,
  scope: "public",
  handler: signedReceiptRoute,
  parity: "exempt:public signed-receipt body read; no MCP tool serves bounty receipt bodies",
  schema: { params: { type: "object", properties: { receiptId: { type: "string" } } },
    response: { type: "object" } },
  events: [],
})));
