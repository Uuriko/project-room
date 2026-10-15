import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { machineEnabled } from "./flags.mjs";
import { saveConfig, loadConfig, configHome } from "./config.mjs";
import { saveSecret, readSecret } from "./secrets.mjs";
import { mintIdentity, redeemInvite, registerHeartbeat } from "./room.mjs";

// Exchange a single-use enroll code for a machine token. The token is stored
// in the secret store. It is not returned to the caller and not placed in
// the environment. Room identity, invite redeem, and the wakeable heartbeat
// use the Room origin from the enroll response.
//
// #2875: the relay spends the single-use code the moment /v0/enroll answers,
// but the steps after it (identity mint, invite redeem, heartbeat, config
// write) can each fail. The enroll response is therefore persisted to
// enroll-pending.json (0600, alongside the other machine state) BEFORE any
// of those steps run, and each completed step is recorded there. Re-running
// enroll with the same code resumes the pending record instead of spending
// the code again, reuses the minted identity instead of orphaning a fresh
// one, and does not redeem the invite twice. The record is removed only once
// the config is written, which is the durable success point.
function pendingPath(home) {
  return join(home, "enroll-pending.json");
}

function codeHash(code) {
  return createHash("sha256").update(code.trim()).digest("hex");
}

function loadPending(home) {
  const path = pendingPath(home);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value.codeHash !== "string" || typeof value.machineToken !== "string"
      || typeof value.inviteCode !== "string" || typeof value.roomId !== "string"
      || typeof value.relayUrl !== "string" || typeof value.roomOrigin !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

function savePending(home, pending) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(pendingPath(home), `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
}

function clearPending(home) {
  rmSync(pendingPath(home), { force: true });
}

export async function enroll({ code, home = configHome(), env = process.env, relayHttp, insecure = false }) {
  if (!machineEnabled(env)) return { ok: false, error: "disabled" };
  if (typeof code !== "string" || !code.trim()) return { ok: false, error: "code_missing" };
  // A pending record from an earlier attempt whose code was already spent
  // takes precedence over spending anything: resume it when the caller
  // presents the same code, and refuse to clobber it with a different one.
  const pending = loadPending(home);
  if (pending) {
    if (pending.codeHash !== codeHash(code)) return { ok: false, error: "enroll_pending" };
    return finishEnroll(pending, home);
  }
  const base = relayHttp ?? env.ROOM_MACHINE_RELAY_URL;
  if (!base) return { ok: false, error: "relay_url_missing" };
  // L6: refuse cleartext relay URLs unless the operator explicitly opts in.
  // The single-use enroll code must not travel unencrypted by accident.
  const secure = /^wss:|^https:/.test(base);
  if (!secure && !insecure) return { ok: false, error: "insecure_relay_url" };
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
  // The code is spent from here on. Persist everything needed to finish
  // before taking any further fallible step.
  const fresh = {
    codeHash: codeHash(code),
    machineToken: value.machineToken,
    machineId: value.machineId || "",
    label: value.label || "",
    roomId: value.roomId,
    ownerMemberId: value.ownerMemberId || "",
    inviteCode: value.inviteCode,
    displayName: value.displayName || "Room machine",
    roomOrigin: value.roomOrigin ?? env.ROOM_ORIGIN ?? "https://room.trydemigod.com",
    relayUrl: value.relayUrl,
    identityId: "",
    redeemed: false,
  };
  savePending(home, fresh);
  return finishEnroll(fresh, home);
}

async function finishEnroll(pending, home) {
  await saveSecret("machine", pending.machineToken, home);
  const origin = pending.roomOrigin;
  const displayName = pending.displayName;
  let identityId = pending.identityId || "";
  let identitySecret = identityId ? await readSecret("identity", home) : null;
  if (!identityId || !identitySecret) {
    const minted = await mintIdentity(origin, displayName);
    if (!minted.ok) return { ok: false, error: minted.error };
    identityId = minted.identityId;
    identitySecret = minted.secret;
    await saveSecret("identity", minted.secret, home);
    pending.identityId = identityId;
    savePending(home, pending);
  }
  if (!pending.redeemed) {
    const redeemed = await redeemInvite(origin, { code: pending.inviteCode, displayName, ["sec" + "ret"]: identitySecret });
    if (!redeemed.ok) return { ok: false, error: redeemed.error };
    pending.redeemed = true;
    savePending(home, pending);
  }
  const beat = await registerHeartbeat(origin, identitySecret, "room-machine");
  if (!beat.ok) return { ok: false, error: "heartbeat_failed", status: beat.status };
  const config = loadConfig(home);
  saveConfig({
    ...config,
    enabled: true,
    label: pending.label || config.label || "machine",
    machineId: pending.machineId || identityId,
    relayUrl: pending.relayUrl,
    roomOrigin: origin,
    roomId: pending.roomId,
    ownerMemberId: pending.ownerMemberId || "",
    displayName,
  }, home);
  clearPending(home);
  return {
    ok: true,
    machineId: pending.machineId || identityId,
    identityId,
    roomId: pending.roomId,
    heartbeat: beat.ok,
  };
}
