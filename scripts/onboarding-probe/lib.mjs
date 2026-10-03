// Shared clock, HTTP, curl reading, and redaction for the onboarding probe.
// Nothing in this file prints a credential. Writers pass values through redact.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export const PROBE_VERSION = "0.1.0";
export const USER_AGENT = `project-room-onboarding-probe/${PROBE_VERSION}`;

// W3-F7: one random password per process — never the hardcoded public
// string. Memory-only; the redact() below keeps it out of artifacts.
const PROBE_PASSWORD = randomBytes(16).toString("base64url");
export function probePassword() { return PROBE_PASSWORD; }

const DOCUMENTED_HOSTS = [
  "https://www.getdasha.com/room",
  "https://www.trydemigod.com/room",
  "https://room.trydemigod.com",
];

const SECRET_KEYS = /secret|password|privatekey|room-key|roomkey/i;

export function elapsed(started) {
  return Math.round(performance.now() - started);
}

export function qaStamp(round = process.env.PROBE_ROUND || "local") {
  const clean = String(round).replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "local";
  return `qa${clean}-probe-${Date.now().toString(36)}`;
}

export function redactText(text) {
  return String(text)
    .replace(/pri_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/rak_[A-Za-z0-9_-]+/g, "[redacted]");
}

export function redact(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(child);
    }
    return out;
  }
  return value;
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${redactText(JSON.stringify(redact(value), null, 2))}\n`);
}

export function rewriteHosts(text, target) {
  const origin = String(target).replace(/\/$/, "");
  let out = text;
  for (const host of DOCUMENTED_HOSTS) out = out.split(host).join(origin);
  return out;
}

export function parseCurl(command) {
  const tokens = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let match;
  while ((match = re.exec(command))) tokens.push(match[1] ?? match[2] ?? match[3]);
  let method = "GET";
  const headers = {};
  let data = null;
  let url = null;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-sS" || token === "-s" || token === "-S" || token === "-f" || token === "-L") continue;
    if (token === "-X") { method = tokens[++i]; continue; }
    if (token === "-A") { i++; continue; }
    if (token === "-H") {
      const header = tokens[++i] ?? "";
      const split = header.indexOf(":");
      if (split > 0) headers[header.slice(0, split).trim()] = header.slice(split + 1).trim();
      continue;
    }
    if (token === "-d" || token === "--data" || token === "--data-raw") { data = tokens[++i] ?? ""; continue; }
    if (!token.startsWith("-") && token.includes("/")) url = token;
  }
  if (data && !Object.keys(headers).some(name => name.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  return { method, url, headers, data, raw: command };
}

export function extractCurls(text) {
  const plain = String(text).replaceAll("`", "");
  const curls = [];
  for (const line of plain.split("\n")) {
    const start = line.indexOf("curl ");
    if (start < 0) continue;
    const parsed = parseCurl(line.slice(start).trim());
    if (parsed.url) curls.push(parsed);
  }
  return curls;
}

export function sectionCurls(packet) {
  const startHeading = packet.search(/^## Start in 3 calls/m);
  const createHeading = packet.search(/^## New agent creating a room/m);
  const begin = startHeading >= 0 ? startHeading : createHeading;
  if (begin < 0) return [];
  const rest = packet.slice(begin);
  const next = rest.slice(2).search(/\n## /);
  const section = next < 0 ? rest : rest.slice(0, next + 2);
  return extractCurls(section);
}

export function boardCloseCurls(packet) {
  return extractCurls(packet).filter(curl => /\/work-claims\b/.test(curl.url) && /"done"/.test(curl.data || ""));
}

export async function probeFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  const started = performance.now();
  const res = await fetch(url, { ...options, headers, redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json, bytes: buf.length, ms: Math.round(performance.now() - started) };
}

export function cookieJar() {
  const jar = new Map();
  return {
    store(response) {
      const list = typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
      for (const line of list) {
        const pair = line.split(";")[0];
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() { return [...jar].map(([key, value]) => `${key}=${value}`).join("; "); },
    get(name) { return jar.get(name) ?? jar.get(`__Host-${name}`) ?? null; },
  };
}

export function emptyCreated() {
  return { rooms: [], identities: [] };
}

export function klmEst({ clicks = 0, chars = 0, words = 0 } = {}) {
  const seconds = clicks * 1.1 + chars * 0.28 + words * 0.3;
  return { seconds: Math.round(seconds * 10) / 10, label: "est." };
}

function fill(parsed, { secret, roomToken, roomId } = {}) {
  const headers = { ...parsed.headers };
  let data = parsed.data;
  const room = roomToken || secret;
  const apply = value => {
    if (typeof value !== "string") return value;
    let next = value;
    if (secret) next = next.replaceAll("<saved-identity-secret>", secret);
    if (room) next = next.replaceAll("<room-mcp-token>", room).replaceAll("$PROJECT_ROOM_SECRET", room);
    return next;
  };
  for (const key of Object.keys(headers)) headers[key] = apply(headers[key]);
  data = apply(data);
  if (roomId && data) data = data.replaceAll('"roomId":"ROOM"', `"roomId":"${roomId}"`);
  return { ...parsed, headers, data };
}

export async function solveProof(displayName, target) {
  const host = new URL(target).hostname;
  if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") {
    const { solveIdentityMintProof } = await import("../../server/agent-identities.mjs");
    return solveIdentityMintProof(displayName);
  }
  const { solveIdentityMintProofRemote } = await import("./pow.mjs");
  return solveIdentityMintProofRemote(displayName);
}

export async function executeCurl(parsed, ctx = {}) {
  const ready = fill(parsed, ctx);
  let response = await probeFetch(ready.url, { method: ready.method, headers: ready.headers, body: ready.data ?? undefined });
  let calls = 1;
  let bytes = response.bytes;
  if (response.status === 428 && response.json?.error?.code === "proof_required" && ready.data) {
    let payload = {};
    try { payload = JSON.parse(ready.data); } catch { payload = {}; }
    const name = typeof payload.displayName === "string" ? payload.displayName : "";
    payload.proof = await solveProof(name, ready.url);
    response = await probeFetch(ready.url, {
      method: ready.method,
      headers: ready.headers,
      body: JSON.stringify(payload),
    });
    calls += 1;
    bytes += response.bytes;
  }
  return { response, calls, bytes };
}
