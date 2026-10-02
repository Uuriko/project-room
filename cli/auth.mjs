// Identity-secret access for the room CLI.
// Commands ask this module for a bearer header and for room_check_access.
// They do not read the secret or assemble the Authorization header themselves.
// Later auth changes belong in this file.
import { roomMcpUrlForHost } from "../src/room-mcp-join.js";
import { edgeDoorApiPath } from "../deploy/agent-discovery.mjs";
import { keychainLookup, keychainStore } from "./keychain.mjs";

export function bearerHeader(secret) {
  if (typeof secret !== "string" || secret.length === 0) throw new Error("Missing identity secret");
  return `Bearer ${secret}`;
}

export function mcpUrl(origin) {
  return roomMcpUrlForHost(origin);
}

export function readyUrl(origin) {
  return origin.replace(/\/$/, "") + edgeDoorApiPath(origin, "/api/ready");
}

export async function rememberSecret(account, secret, env = process.env) {
  return keychainStore(account, secret, env);
}

export async function loadSecret(account, fileSecret, env = process.env) {
  const stored = await keychainLookup(account, env);
  if (typeof stored === "string" && stored.length > 0) return stored;
  if (typeof fileSecret !== "string" || fileSecret.length === 0) throw new Error("Saved connection has no identity secret");
  return fileSecret;
}

export async function checkAccess({ origin, secret, fetchImpl = globalThis.fetch }) {
  let response;
  try {
    response = await fetchImpl(mcpUrl(origin), {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: bearerHeader(secret),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "room-doctor",
        method: "tools/call",
        params: { name: "room_check_access", arguments: {} },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { ok: false, down: true };
  }
  if (response.status >= 500) return { ok: false, down: true, status: response.status };
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 401 || response.status === 403 || body?.error) return { ok: false, down: false, status: response.status };
  const result = body?.result;
  if (!result || result.isError) return { ok: false, down: false, status: response.status };
  const status = result.structuredContent?.status;
  if (status && status !== "credential_accepted") return { ok: false, down: false, status: response.status };
  return { ok: true, down: false, status: response.status };
}

export async function checkReady({ origin, fetchImpl = globalThis.fetch }) {
  let response;
  try {
    response = await fetchImpl(readyUrl(origin), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { ok: false, down: true };
  }
  if (!response.ok) return { ok: false, down: true, status: response.status };
  return { ok: true, down: false, status: response.status };
}
