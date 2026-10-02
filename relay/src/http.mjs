import { RelayError, relayError } from "./errors.mjs";

export const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
});

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function errorResponse(error, headers = {}) {
  const known = error instanceof RelayError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "internal";
  const message = known ? error.message : "The relay could not complete that request";
  const extra = known ? error.extra : {};
  return json(status, { error: { code, message, ...extra } }, headers);
}

export async function readJson(request, limit, noun = "Request body") {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    throw relayError(413, "payload_too_large", `${noun} exceeds ${limit} bytes`);
  }
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(type)) throw relayError(415, "json_required", "Use application/json");
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > limit) throw relayError(413, "payload_too_large", `${noun} exceeds ${limit} bytes`);
  if (buffer.byteLength === 0) throw relayError(400, "invalid_json", "Expected a JSON object");
  try {
    const value = JSON.parse(new TextDecoder().decode(buffer));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw relayError(400, "invalid_json", "Expected a JSON object");
    return { value, raw: new TextDecoder().decode(buffer) };
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw relayError(400, "invalid_json", "Expected a JSON object");
  }
}

export function bearer(request) {
  const match = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? "";
}
