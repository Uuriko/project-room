import { createHash } from "node:crypto";
import { machineEnabled } from "./flags.mjs";
import { saveConfig, loadConfig, configHome } from "./config.mjs";
import { readSecret, saveSecret } from "./secrets.mjs";
import { mintIdentity, redeemInvite, registerHeartbeat } from "./room.mjs";

const codeHash = code => createHash("sha256").update(`room-machine-enroll:${code}`).digest("hex");

// Exchange a single-use enroll code for a machine token. The token is stored
// in the secret store. It is not returned to the caller and not placed in
// the environment. Room identity, invite redeem, and the wakeable heartbeat
// use the Room origin from the enroll response.
//
// The relay spends the code on the exchange, but three Room calls follow it
// (identity mint, invite redeem, heartbeat), and any of them can fail: the
// daily identity limit (429), a 5xx, a dropped connection. So the exchange is
// journaled as config.pendingEnroll (no secrets in it; the token and invite
// code go to the secret store), and the Room identity is minted once and
// reused. Running enroll again with the same code resumes from the journal
// instead of asking the relay for a code it already marked used. Redeem is
// idempotent for the identity that already redeemed the invite.
export async function enroll({ code, home = configHome(), env = process.env, relayHttp, insecure = false }) {
  if (!machineEnabled(env)) return { ok: false, error: "disabled" };
  const base = relayHttp ?? env.ROOM_MACHINE_RELAY_URL;
  if (!base) return { ok: false, error: "relay_url_missing" };
  if (typeof code !== "string" || !code.trim()) return { ok: false, error: "code_missing" };
  // L6: refuse cleartext relay URLs unless the operator explicitly opts in.
  // The single-use enroll code must not travel unencrypted by accident.
  const secure = /^wss:|^https:/.test(base);
  if (!secure && !insecure) return { ok: false, error: "insecure_relay_url" };
  const hash = codeHash(code.trim());
  let pending = loadConfig(home).pendingEnroll ?? null;
  if (pending?.codeHash !== hash) pending = null;
  if (!pending) {
    const httpBase = base.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    const response = await fetch(new URL("/v0/enroll", httpBase), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
    const value = await response.json().catch(() => null);
    if (response.status === 410) return { ok: false, error: value?.error ?? "code_expired" };
    if (!response.ok || !value?.machineToken || !value.roomId || !value.inviteCode || !value.relayUrl) {
      return { ok: false, error: "enroll_rejected", status: response.status };
    }
    await saveSecret("machine", value.machineToken, home);
    await saveSecret("enroll-invite", value.inviteCode, home);
    pending = {
      codeHash: hash,
      machineId: value.machineId || "",
      label: value.label || "",
      relayUrl: value.relayUrl,
      roomOrigin: value.roomOrigin ?? env.ROOM_ORIGIN ?? "https://room.trydemigod.com",
      roomId: value.roomId,
      ownerMemberId: value.ownerMemberId || "",
      displayName: value.displayName || "Room machine",
      identityId: null,
    };
    saveConfig({ ...loadConfig(home), pendingEnroll: pending }, home);
  }
  let result;
  try {
    result = await finishEnroll(pending, home);
  } catch {
    result = { ok: false, error: "enroll_incomplete", resumable: true };
  }
  if (result.resumable) result.next = "Run enroll again with the same code. It resumes where it stopped; the relay is not asked again.";
  return result;
}

async function finishEnroll(pending, home) {
  const origin = pending.roomOrigin;
  const displayName = pending.displayName;
  let secret = pending.identityId ? await readSecret("identity", home) : null;
  let identityId = secret ? pending.identityId : null;
  if (!secret) {
    const minted = await mintIdentity(origin, displayName);
    if (!minted.ok) return { ok: false, error: minted.error, status: minted.status, resumable: true };
    await saveSecret("identity", minted.secret, home);
    secret = minted.secret;
    identityId = minted.identityId;
    pending = { ...pending, identityId };
    saveConfig({ ...loadConfig(home), pendingEnroll: pending }, home);
  }
  const inviteCode = await readSecret("enroll-invite", home);
  const redeemed = await redeemInvite(origin, { code: inviteCode, displayName, secret });
  if (!redeemed.ok) return { ok: false, error: redeemed.error, status: redeemed.status, resumable: true };
  const beat = await registerHeartbeat(origin, secret, "room-machine");
  if (!beat.ok) return { ok: false, error: "heartbeat_failed", status: beat.status, resumable: true };
  await saveSecret("enroll-invite", "", home);
  const { pendingEnroll: _done, ...config } = loadConfig(home);
  saveConfig({
    ...config,
    enabled: true,
    label: pending.label || config.label || "machine",
    machineId: pending.machineId || identityId,
    relayUrl: pending.relayUrl,
    roomOrigin: origin,
    roomId: pending.roomId,
    ownerMemberId: pending.ownerMemberId,
    displayName,
  }, home);
  return {
    ok: true,
    machineId: pending.machineId || identityId,
    identityId,
    roomId: pending.roomId,
    heartbeat: beat.ok,
  };
}
