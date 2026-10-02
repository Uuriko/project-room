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
  const loaded = await runCommand("pfctl", ["-a", "room.machine", "-f", anchorPath], { timeoutMs: 5000 });
  if (loaded.code !== 0) return { ok: false, error: "pf anchor failed", changes };
  changes.push({
    id: "pf.anchor",
    gateway: anchor.gateway,
    hosts: anchor.hosts,
    revert: ["pfctl", "-a", "room.machine", "-F", "all"],
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
