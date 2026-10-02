import { randomBytes } from "node:crypto";
import { runCommand } from "./spawn.mjs";
import { saveSecret } from "./secrets.mjs";
import { MAX_MACOS_GUESTS } from "./protocol.mjs";

export const GUEST_LIMIT = MAX_MACOS_GUESTS;

async function lume(args, options = {}) {
  return runCommand("lume", args, { timeoutMs: 120_000, maxBytes: 1024 * 1024, ...options });
}

export function guestName(slot, claimId) {
  if (slot === "desk") return "desk";
  const safe = String(claimId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  return `scratch-${safe || "lease"}`;
}

// Headless, VNC left on (Lume has no loopback-bind flag). The host pf anchor
// drops inbound 5900-5999 except on lo0, which is what keeps the console local.
export function runArgs(name, { window = false } = {}) {
  return ["run", name, "--display", window ? "native" : "none", "--detach"];
}

export async function runningGuests(state) {
  return Object.values(state.running ?? {}).filter(Boolean);
}

export async function startGuest(state, name) {
  state.running ??= {};
  if (state.running[name]) return { ok: true, already: true };
  const live = Object.keys(state.running).length;
  if (live >= GUEST_LIMIT) {
    return { ok: false, code: "guest_limit", message: `This Mac already has ${live} macOS guests running. The limit is ${GUEST_LIMIT}.` };
  }
  const started = await lume(runArgs(name));
  if (started.code !== 0) return { ok: false, code: "unavailable", message: "lume run failed" };
  state.running[name] = true;
  return { ok: true };
}

export async function stopGuest(state, name) {
  await lume(["stop", name]);
  if (state.running) delete state.running[name];
}

export async function suspendGuests(state) {
  const names = Object.keys(state.running ?? {});
  for (const name of names) {
    const suspended = await lume(["suspend", name], { timeoutMs: 20_000 });
    if (suspended.code !== 0) await lume(["stop", name], { timeoutMs: 20_000 });
  }
}

export async function stopAllGuests(state) {
  const names = Object.keys(state.running ?? {});
  for (const name of names) await stopGuest(state, name);
}

export async function ensureDeskClone() {
  const cloned = await lume(["clone", "golden", "desk"]);
  return cloned.code === 0;
}

export async function snapshotDesk(claimId) {
  const snap = `desk-snap-${String(claimId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20)}`;
  const cloned = await lume(["clone", "desk", snap]);
  return cloned.code === 0 ? snap : null;
}

export async function createScratch(claimId) {
  const name = guestName("scratch", claimId);
  const cloned = await lume(["clone", "golden", name]);
  if (cloned.code !== 0) return null;
  return name;
}

export async function deleteGuest(state, name) {
  await stopGuest(state, name);
  await lume(["delete", name]);
}

export async function guestGrants(vm) {
  const result = await runCommand("lume", ["ssh", vm, "--", "cua-driver", "permissions", "status", "--json"], {
    timeoutMs: 20_000, maxBytes: 64 * 1024,
  });
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout.toString("utf8")); } catch { return null; }
}

export function grantsOk(grants) {
  return Boolean(grants && grants.accessibility === true && grants.screen_recording === true);
}

// Create the golden guest, randomize its password into the secret store,
// and ask the guest for its real permission status. A failed console check
// is a failure. This never writes a success it did not measure.
export async function prepareGolden({ home, postNotice, state }) {
  const created = await lume(["create", "golden", "--ipsw", "latest", "--unattended", "tahoe"]);
  if (created.code !== 0) return { ok: false, grants: null, ownerAction: false, message: "lume create failed" };
  const started = await startGuest(state, "golden");
  if (!started.ok) return { ok: false, ...started, grants: null, ownerAction: false };
  const password = randomBytes(18).toString("base64url");
  await saveSecret("guest-golden", password, home);
  await runCommand("lume", ["ssh", "golden", "--", "passwd", "lume"], {
    input: `${password}\n${password}\n`, timeoutMs: 20_000,
  });
  let grants = await guestGrants("golden");
  let ownerAction = false;
  if (!grantsOk(grants)) {
    const notice = "Owner action needed: four toggles in the VM window (Accessibility, Screen Recording, Automation of System Events, Tahoe direct capture).";
    await startGuest(state, "golden");
    await lume(["stop", "golden"]);
    delete state.running.golden;
    await lume(runArgs("golden", { window: true }));
    state.running.golden = true;
    if (postNotice) await postNotice(notice);
    ownerAction = true;
    grants = await guestGrants("golden");
  }
  const ok = grantsOk(grants);
  if (ok) {
    await stopGuest(state, "golden");
    await ensureDeskClone();
  }
  return { ok, grants, ownerAction, message: ok ? "golden ready" : "guest permissions are not granted" };
}
