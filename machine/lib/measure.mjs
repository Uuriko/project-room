import { readFileSync } from "node:fs";
import { runCommand } from "./spawn.mjs";

// Every fact below is the command's own output. A failed probe is
// "not measured" or "absent". Nothing here is filled in from a guess.
async function text(command, args, timeoutMs = 4000) {
  const result = await runCommand(command, args, { timeoutMs, maxBytes: 64 * 1024 });
  if (result.timedOut || result.capped || result.code !== 0) return null;
  const value = result.stdout.toString("utf8").trim();
  return value || null;
}

export async function measureHost() {
  const arch = await text("uname", ["-m"]);
  const chip = await text("sysctl", ["-n", "machdep.cpu.brand_string"]);
  let ramGb = null;
  const memsize = await text("sysctl", ["-n", "hw.memsize"]);
  if (memsize && /^\d+$/.test(memsize)) ramGb = Math.round(Number(memsize) / (1024 ** 3));
  if (ramGb == null) {
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf8");
      const kb = /MemTotal:\s+(\d+)/.exec(meminfo)?.[1];
      if (kb) ramGb = Math.round(Number(kb) / (1024 ** 2));
    } catch { /* not measured */ }
  }
  const disk = await text("df", ["-Pk", "/"]);
  let diskFreeGb = null;
  if (disk) {
    const line = disk.split("\n").find(row => row.trim() && !row.startsWith("Filesystem"));
    const avail = line?.trim().split(/\s+/)[3];
    if (avail && /^\d+$/.test(avail)) diskFreeGb = Math.round(Number(avail) / (1024 ** 2));
  }
  const macos = await text("sw_vers", ["-productVersion"]);
  const lume = await text("lume", ["--version"]) ?? await text("lume", ["version"]);
  const driver = await text("cua-driver", ["--version"]);
  let grants = null;
  const grantText = await text("cua-driver", ["permissions", "status", "--json"]);
  if (grantText) {
    try { grants = JSON.parse(grantText); } catch { grants = null; }
  }
  let ollama = "absent";
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1000) });
    ollama = response.ok ? "present" : "absent";
  } catch { ollama = "absent"; }
  const xcode = await text("xcodebuild", ["-version"]);
  return {
    arch: arch ?? "not measured",
    chip: chip ?? "not measured",
    ramGb: ramGb ?? "not measured",
    diskFreeGb: diskFreeGb ?? "not measured",
    macos: macos ?? "not measured",
    lume: lume ?? "not measured",
    driver: driver ?? "not measured",
    guestGrants: grants ?? "not measured",
    ollama,
    xcode: xcode ? "present" : "absent",
  };
}

export function doctorText(facts) {
  const grants = typeof facts.guestGrants === "string"
    ? facts.guestGrants
    : JSON.stringify(facts.guestGrants);
  return [
    "Machine doctor",
    `arch: ${facts.arch}`,
    `chip: ${facts.chip}`,
    `ramGb: ${facts.ramGb}`,
    `diskFreeGb: ${facts.diskFreeGb}`,
    `macos: ${facts.macos}`,
    `lume: ${facts.lume}`,
    `driver: ${facts.driver}`,
    `guestGrants: ${grants}`,
    `ollama: ${facts.ollama}`,
    `xcode: ${facts.xcode}`,
  ].join("\n");
}

export async function hostAddresses() {
  const result = await text("hostname", ["-I"]) ?? await text("ip", ["-4", "-o", "addr", "show"]);
  if (!result) return [];
  return [...result.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map(match => match[0])
    .filter(ip => ip !== "127.0.0.1");
}

export async function gatewayAddress() {
  const route = await text("ip", ["route", "show", "default"]) ?? await text("netstat", ["-nr"]);
  if (!route) return null;
  const match = route.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return match ? match[0] : null;
}

export async function onAcPower() {
  const battery = await text("pmset", ["-g", "batt"]);
  if (!battery) return null;
  return /AC Power|'AC Power'|Now drawing from 'AC Power'/i.test(battery);
}
