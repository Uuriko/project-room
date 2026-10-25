// Loopback server shared by the safety-net stories, invariants, and budget check.
// Responses stay in memory. Callers assert status and error codes and never print
// bodies, cookies, or credentials.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../../server/store.mjs";
import { createRoomServer } from "../../server/http.mjs";

const GAP_FILE = new URL("./KNOWN-GAPS.md", import.meta.url);

export const PAUSE_WRITE_GAP = "paused-agents-cannot-write";

export function knownGap(heading) {
  let text = "";
  try { text = readFileSync(GAP_FILE, "utf8"); }
  catch { return false; }
  return text.includes(`## ${heading}\n`);
}

export async function startSafetyNet(t) {
  const directory = mkdtempSync(join(tmpdir(), "safety-net-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, origin, call: (path, options) => request(origin, path, options) };
}

export async function request(origin, path, { method = "GET", data, token, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      "User-Agent": "project-room-agent",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const text = await response.text();
  let body = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); }
    catch { body = null; }
  }
  return { status: response.status, body, setCookie: response.headers.get("set-cookie") || "" };
}

export function errorCode(body) {
  return body && body.error && typeof body.error.code === "string" ? body.error.code : null;
}

export function accountCookie(setCookie) {
  const match = /account_session=([^;,\s]+)/.exec(setCookie || "");
  return match ? match[1] : null;
}

export function accountHeaders(session, cookie) {
  return {
    Cookie: `account_session=${cookie}`,
    "X-CSRF-Token": session.csrf,
    "X-Session-Binding": session.sessionBinding,
    "X-Project-Room-Auth": "account"
  };
}

export function containsSecret(value, secret) {
  return typeof secret === "string" && secret.length >= 8 && JSON.stringify(value).includes(secret);
}
