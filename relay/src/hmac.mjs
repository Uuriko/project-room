import { hex, timingEqual } from "./bytes.mjs";
import { relayError } from "./errors.mjs";
import { HMAC_SKEW_SEC } from "./protocol.mjs";

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return hex(new Uint8Array(mac));
}

export async function verifyLinkSignature(secret, request, rawBody, nowSec) {
  if (!secret) throw relayError(503, "relay_unconfigured", "RELAY_LINK_SECRET is not set");
  const timestamp = request.headers.get("x-relay-timestamp") ?? "";
  const signature = (request.headers.get("x-relay-signature") ?? "").toLowerCase();
  if (!/^[0-9]{10,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) {
    throw relayError(401, "unauthenticated", "The link signature was refused");
  }
  const stamp = Number(timestamp);
  if (Math.abs(nowSec - stamp) > HMAC_SKEW_SEC) {
    throw relayError(401, "unauthenticated", "The link signature was refused");
  }
  // The path is part of the signed material: without it a signature cut
  // for /resume is equally valid for /halt (same timestamp, same body),
  // so a captured resume could halt the machine and vice versa.
  const path = new URL(request.url).pathname;
  const expected = await hmacHex(secret, `${timestamp}.${path}.${rawBody}`);
  if (!timingEqual(expected, signature)) throw relayError(401, "unauthenticated", "The link signature was refused");
}
