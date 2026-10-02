import { createHash, randomUUID } from "node:crypto";
import { readSecret } from "./secrets.mjs";
import { configHome } from "./config.mjs";

const POW_BITS = 12;
const POW_WINDOW_MS = 10 * 60 * 1000;

export function solveIdentityProof(displayName, now = Date.now(), bits = POW_BITS) {
  const name = displayName.trim();
  const bucket = Math.floor(now / POW_WINDOW_MS);
  const prefix = "0".repeat(bits / 4);
  for (let i = 0; i < 2_000_000; i += 1) {
    const nonce = i.toString(36);
    const hex = createHash("sha256").update(`${bucket}:${name}:${nonce}`).digest("hex");
    if (hex.startsWith(prefix)) return nonce;
  }
  throw new Error("identity proof was not found");
}

async function roomFetch(origin, path, { token, method = "GET", body } = {}) {
  const headers = { accept: "application/json", origin };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value = null;
  if (text) { try { value = JSON.parse(text); } catch { value = { raw: text }; } }
  return { status: response.status, value };
}

export async function mintIdentity(origin, displayName) {
  const proof = solveIdentityProof(displayName);
  let minted = await roomFetch(origin, "/api/agent-identities", {
    method: "POST", body: { displayName, proof },
  });
  if (minted.status === 428) {
    const bits = minted.value?.proof?.bits ?? POW_BITS;
    const bucket = minted.value?.proof?.bucket;
    const name = displayName.trim();
    const prefix = "0".repeat(bits / 4);
    let nonce = null;
    const buckets = minted.value?.proof?.acceptBuckets ?? [bucket];
    for (const candidate of buckets) {
      for (let i = 0; i < 2_000_000 && !nonce; i += 1) {
        const trial = i.toString(36);
        const hex = createHash("sha256").update(`${candidate}:${name}:${trial}`).digest("hex");
        if (hex.startsWith(prefix)) nonce = trial;
      }
    }
    minted = await roomFetch(origin, "/api/agent-identities", {
      method: "POST", body: { displayName, proof: nonce },
    });
  }
  if (minted.status !== 201 && minted.status !== 200) {
    return { ok: false, status: minted.status, error: minted.value?.error?.code ?? "identity_failed" };
  }
  return { ok: true, identityId: minted.value.identityId, secret: minted.value.secret };
}

export async function redeemInvite(origin, { code, displayName, secret }) {
  const redeemed = await roomFetch(origin, "/api/agent-invites/redeem", {
    method: "POST", token: secret, body: { code, displayName },
  });
  if (redeemed.status !== 201 && redeemed.status !== 200) {
    return { ok: false, status: redeemed.status, error: redeemed.value?.error?.code ?? "invite_failed" };
  }
  return { ok: true, roomId: redeemed.value.roomId, memberId: redeemed.value.memberId ?? redeemed.value.identityId };
}

export async function registerHeartbeat(origin, secret, hostId = "room-machine") {
  const beat = await roomFetch(origin, "/api/agent-heartbeats", {
    method: "POST", token: secret, body: { hostId, mode: "wakeable" },
  });
  return { ok: beat.status === 200, status: beat.status, value: beat.value };
}

export async function postMessage(origin, roomId, secret, body) {
  const id = randomUUID();
  const posted = await roomFetch(origin, `/api/rooms/${encodeURIComponent(roomId)}/commands`, {
    method: "POST",
    token: secret,
    body: { id, type: "message.posted", data: { messageId: id, body } },
  });
  return { ok: posted.status === 201 || posted.status === 200, status: posted.status, value: posted.value };
}

export async function listEvents(origin, roomId, secret, after = 0) {
  const page = await roomFetch(origin, `/api/rooms/${encodeURIComponent(roomId)}/events?after=${after}&limit=100`, { token: secret });
  if (page.status !== 200) return { ok: false, events: [], next: after };
  return { ok: true, events: page.value.events ?? [], next: page.value.next ?? after };
}

export async function stageFile(origin, roomId, secret, { filename, mediaType, bytes }) {
  const data = Buffer.from(bytes).toString("base64");
  const staged = await roomFetch(origin, `/api/rooms/${encodeURIComponent(roomId)}/files`, {
    method: "POST",
    token: secret,
    body: { id: randomUUID(), filename, mediaType, data },
  });
  if (staged.status !== 201 && staged.status !== 200) return { ok: false, status: staged.status };
  const sha = staged.value?.attachment?.sha256;
  if (!/^[0-9a-f]{64}$/.test(sha ?? "")) return { ok: false, status: staged.status };
  return { ok: true, blob: `sha256:${sha}` };
}

export async function updateClaim(origin, roomId, secret, claimId, body) {
  const updated = await roomFetch(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}/update`, {
    method: "POST", token: secret, body,
  });
  return { ok: updated.status === 200 || updated.status === 201, status: updated.status, value: updated.value };
}

export async function identitySecret(home = configHome()) {
  return readSecret("identity", home);
}
