import { machineEnabled } from "./flags.mjs";
import { saveConfig, loadConfig, configHome } from "./config.mjs";
import { saveSecret } from "./secrets.mjs";
import { mintIdentity, redeemInvite, registerHeartbeat } from "./room.mjs";

// Exchange a single-use enroll code for a machine token. The token is stored
// in the secret store. It is not returned to the caller and not placed in
// the environment. Room identity, invite redeem, and the wakeable heartbeat
// use the Room origin from the enroll response.
export async function enroll({ code, home = configHome(), env = process.env, relayHttp, insecure = false }) {
  if (!machineEnabled(env)) return { ok: false, error: "disabled" };
  const base = relayHttp ?? env.ROOM_MACHINE_RELAY_URL;
  if (!base) return { ok: false, error: "relay_url_missing" };
  if (typeof code !== "string" || !code.trim()) return { ok: false, error: "code_missing" };
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
  await saveSecret("machine", value.machineToken, home);
  const origin = value.roomOrigin ?? env.ROOM_ORIGIN ?? "https://room.trydemigod.com";
  const displayName = value.displayName || "Room machine";
  const minted = await mintIdentity(origin, displayName);
  if (!minted.ok) return { ok: false, error: minted.error };
  await saveSecret("identity", minted.secret, home);
  const redeemed = await redeemInvite(origin, { code: value.inviteCode, displayName, secret: minted.secret });
  if (!redeemed.ok) return { ok: false, error: redeemed.error };
  const beat = await registerHeartbeat(origin, minted.secret, "room-machine");
  if (!beat.ok) return { ok: false, error: "heartbeat_failed", status: beat.status };
  const config = loadConfig(home);
  saveConfig({
    ...config,
    enabled: true,
    label: value.label || config.label || "machine",
    machineId: value.machineId || minted.identityId,
    relayUrl: value.relayUrl,
    roomOrigin: origin,
    roomId: value.roomId,
    ownerMemberId: value.ownerMemberId || "",
    displayName,
  }, home);
  return {
    ok: true,
    machineId: value.machineId || minted.identityId,
    identityId: minted.identityId,
    roomId: value.roomId,
    heartbeat: beat.ok,
  };
}
