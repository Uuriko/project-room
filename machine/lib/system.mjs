import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./spawn.mjs";
import { configHome } from "./config.mjs";
import { gatewayAddress, hostAddresses } from "./measure.mjs";

const RECORD = "system-changes.json";

function recordPath(home) {
  return join(home, RECORD);
}

export function loadChanges(home = configHome()) {
  const path = recordPath(home);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? parsed : [];
}

function saveChanges(changes, home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(recordPath(home), `${JSON.stringify(changes, null, 2)}\n`, { mode: 0o600 });
}

async function readPmset(key) {
  const result = await runCommand("pmset", ["-g"], { timeoutMs: 5000 });
  if (result.code !== 0) return null;
  const line = result.stdout.toString("utf8").split("\n").map(row => row.trim())
    .find(row => row.startsWith(`${key} `) || row.startsWith(`${key}\t`));
  if (!line) return null;
  const value = line.split(/\s+/)[1];
  return value ?? null;
}

export async function anchorRules() {
  const hosts = await hostAddresses();
  const gateway = await gatewayAddress();
  const lines = [
    "# room-machine egress anchor. VM bridge: internet and measured gateway DNS only.",
    "block drop quick inet from any to 10.0.0.0/8",
    "block drop quick inet from any to 172.16.0.0/12",
    "block drop quick inet from any to 192.168.0.0/16",
    "block drop quick inet from any to 169.254.0.0/16",
    "block drop quick inet from any to 169.254.169.254",
    "block in quick on !lo0 proto tcp from any to any port 5900:5999",
  ];
  for (const host of hosts) lines.push(`block drop quick inet from any to ${host}`);
  if (gateway) {
    lines.push(`pass out quick inet proto udp from any to ${gateway} port 53`);
    lines.push(`pass out quick inet proto tcp from any to ${gateway} port 53`);
  }
  lines.push("pass out quick inet proto tcp from any to any keep state");
  lines.push("pass out quick inet proto udp from any to any keep state");
  return { text: `${lines.join("\n")}\n`, gateway, hosts };
}

const PF_ANCHOR_NAME = "room.machine";
const PF_CONF_PATH = "/etc/pf.conf";
const PF_ANCHOR_LINE = `anchor "${PF_ANCHOR_NAME}"`;

// An anchor loaded with pfctl -a only evaluates when it is referenced from
// the main pf.conf, and pf is disabled by default on macOS. Without both,
// the anchor rules are dead config. This wires the anchor and enables pf,
// failing loudly when the host cannot be protected.
async function wirePfAnchor() {
  let conf;
  try {
    conf = readFileSync(PF_CONF_PATH, "utf8");
  } catch {
    return { ok: false, error: "could not read /etc/pf.conf" };
  }
  let addedLine = false;
  if (!conf.split("\n").some(line => line.trim() === PF_ANCHOR_LINE)) {
    try {
      writeFileSync(PF_CONF_PATH, conf.endsWith("\n") ? `${conf}${PF_ANCHOR_LINE}\n` : `${conf}\n${PF_ANCHOR_LINE}\n`);
      addedLine = true;
    } catch {
      return { ok: false, error: "could not write /etc/pf.conf (needs sudo)" };
    }
  }
  const info = await runCommand("pfctl", ["-s", "info"], { timeoutMs: 5000 });
  const enabled = info.code === 0 && /^Status:\s+Enabled/m.test(info.stdout.toString("utf8"));
  if (!enabled) {
    const enable = await runCommand("pfctl", ["-e"], { timeoutMs: 5000 });
    if (enable.code !== 0) return { ok: false, error: "pfctl -e failed: pf cannot be enabled", addedLine };
    const recheck = await runCommand("pfctl", ["-s", "info"], { timeoutMs: 5000 });
    if (recheck.code !== 0 || !/^Status:\s+Enabled/m.test(recheck.stdout.toString("utf8"))) {
      return { ok: false, error: "pf is not enabled after pfctl -e", addedLine };
    }
  }
  return { ok: true, addedLine };
}
// One recorded change list. The installer runs these under a single sudo.
// Uninstall runs the recorded revert commands and no others.
export async function applySystemChanges(home = configHome()) {
  const changes = [];
  for (const key of ["disablesleep", "autorestart"]) {
    const previous = await readPmset(key);
    const revertValue = previous ?? "0";
    const applied = await runCommand("pmset", ["-a", key, "1"], { timeoutMs: 5000 });
    if (applied.code !== 0) {
      return { ok: false, error: `pmset ${key} failed`, changes };
    }
    changes.push({
      id: `pmset.${key}`,
      previous,
      revert: ["pmset", "-a", key, revertValue],
    });
  }
  const anchor = await anchorRules();
  const anchorPath = join(home, "pf-anchor.conf");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(anchorPath, anchor.text, { mode: 0o644 });
  const loaded = await runCommand("pfctl", ["-a", PF_ANCHOR_NAME, "-f", anchorPath], { timeoutMs: 5000 });
  if (loaded.code !== 0) return { ok: false, error: "pf anchor failed", changes };
  // The loaded anchor evaluates only when referenced from /etc/pf.conf and
  // pf is enabled. Wire both and verify the anchor is live.
  const wired = await wirePfAnchor();
  if (!wired.ok) return { ok: false, error: `pf anchor wiring failed: ${wired.error}`, changes };
  const anchors = await runCommand("pfctl", ["-s", "Anchors"], { timeoutMs: 5000 });
  if (anchors.code !== 0 || !anchors.stdout.toString("utf8").split("\n").some(line => line.trim() === PF_ANCHOR_NAME)) {
    return { ok: false, error: "pf anchor is not live after wiring", changes };
  }
  changes.push({
    id: "pf.anchor",
    gateway: anchor.gateway,
    hosts: anchor.hosts,
    revert: wired.addedLine
      // One command: remove the anchor reference from pf.conf, then flush.
      ? ["sh", "-c", `sed -i '' '/^anchor "${PF_ANCHOR_NAME}"$/d' ${PF_CONF_PATH} && pfctl -a ${PF_ANCHOR_NAME} -F all`]
      : ["pfctl", "-a", PF_ANCHOR_NAME, "-F", "all"],
  });
  const domains = [
    ["AllowedEthernetLocalNetworkAddresses", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    ["AllowedWiFiLocalNetworkAddresses", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  ];
  for (const [key, ...values] of domains) {
    const before = await runCommand("defaults", ["read", "com.apple.network.local-network", key], { timeoutMs: 5000 });
    const previous = before.code === 0 ? before.stdout.toString("utf8") : null;
    const wrote = await runCommand("defaults", [
      "write", "com.apple.network.local-network", key, "-array", ...values,
    ], { timeoutMs: 5000 });
    if (wrote.code !== 0) return { ok: false, error: `defaults ${key} failed`, changes };
    changes.push({
      id: `defaults.${key}`,
      previous,
      revert: previous == null
        ? ["defaults", "delete", "com.apple.network.local-network", key]
        : ["defaults", "write", "com.apple.network.local-network", key, "-string", previous.trim()],
    });
  }
  saveChanges(changes, home);
  return { ok: true, changes, anchor };
}

export async function revertSystemChanges(home = configHome()) {
  const changes = loadChanges(home);
  const ran = [];
  for (const change of [...changes].reverse()) {
    const result = await runCommand(change.revert[0], change.revert.slice(1), { timeoutMs: 5000 });
    ran.push({ id: change.id, code: result.code });
    if (result.code !== 0) return { ok: false, ran };
  }
  rmSync(recordPath(home), { force: true });
  return { ok: true, ran };
}
