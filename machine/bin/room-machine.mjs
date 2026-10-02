#!/usr/bin/env node
import { machineEnabled } from "../lib/flags.mjs";
import { configHome, loadConfig, saveConfig } from "../lib/config.mjs";
import { MachineDaemon } from "../lib/daemon.mjs";
import { doctorReport } from "../lib/doctor.mjs";
import { enroll } from "../lib/enroll.mjs";
import { preflight } from "../lib/preflight.mjs";
import { applySystemChanges, revertSystemChanges } from "../lib/system.mjs";
import { prepareGolden } from "../lib/vms.mjs";
import { disableBot, enableBot, normalizeBot } from "../bot/config.mjs";
import { providerNeedsKey, saveProviderKey } from "../bot/keys.mjs";

const argv = process.argv.slice(2);
const command = argv[0] ?? "status";
const home = configHome();

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", chunk => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function flagValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function flagValues(name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) values.push(value);
  }
  return values;
}

function off() {
  console.log("room-machine is off. Set ROOM_MACHINE_ENABLED=1 to turn it on.");
}

const PROVIDERS = new Set(["local", "anthropic", "openai", "dasha", "none"]);

async function main() {
  if (command === "status") {
    const config = loadConfig(home);
    const daemon = new MachineDaemon({ home });
    const status = daemon.status();
    const bot = normalizeBot(config.bot);
    console.log(JSON.stringify({
      ...status,
      enabled: machineEnabled() && config.enabled === true,
      label: config.label || null,
      bot: { enabled: bot.enabled, rooms: bot.rooms, tier: bot.tier },
    }));
    return;
  }
  if (command === "stop") {
    const daemon = new MachineDaemon({ home });
    await daemon.stop();
    console.log("stopped");
    return;
  }
  if (command === "uninstall") {
    const daemon = new MachineDaemon({ home });
    await daemon.stop();
    const reverted = await revertSystemChanges(home);
    console.log(JSON.stringify({ uninstalled: reverted.ok, reverted: reverted.ran }));
    process.exitCode = reverted.ok ? 0 : 1;
    return;
  }
  if (!machineEnabled()) {
    off();
    process.exitCode = command === "preflight" ? 0 : 2;
    return;
  }
  if (command === "preflight") {
    const result = await preflight();
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === "apply-system") {
    const result = await applySystemChanges(home);
    console.log(JSON.stringify({ ok: result.ok, error: result.error ?? null, changes: (result.changes ?? []).map(change => change.id) }));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === "doctor") {
    const report = await doctorReport({ home });
    console.log(report.body);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (command === "pause") {
    const index = argv.indexOf("--minutes");
    const minutes = Number(argv[index + 1]);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      console.log("pause needs --minutes N");
      process.exitCode = 2;
      return;
    }
    const daemon = new MachineDaemon({ home });
    const paused = await daemon.pause(minutes);
    console.log(JSON.stringify(paused));
    return;
  }
  if (command === "resume") {
    const daemon = new MachineDaemon({ home });
    console.log(JSON.stringify(await daemon.resume()));
    return;
  }
  if (command === "provider" && argv[1] === "set") {
    const name = argv[2];
    if (!PROVIDERS.has(name)) {
      console.log("provider must be local, anthropic, openai, dasha, or none");
      process.exitCode = 2;
      return;
    }
    if (argv.length > 3) {
      console.log("The key is read from stdin. Do not pass it as an argument.");
      process.exitCode = 2;
      return;
    }
    if (providerNeedsKey(name)) {
      const saved = await saveProviderKey(name, await readStdin(), home);
      if (!saved.ok) {
        console.log("A key is required on stdin.");
        process.exitCode = 2;
        return;
      }
    }
    const config = loadConfig(home);
    config.provider = name;
    config.enabled = true;
    saveConfig(config, home);
    console.log(JSON.stringify({ provider: name }));
    return;
  }
  if (command === "bot" && argv[1] === "enable") {
    const config = loadConfig(home);
    const enabled = enableBot(config.bot, { roomId: flagValue("--room"), goMembers: flagValues("--go") });
    if (!enabled.ok) {
      console.log("bot enable needs --room <roomId>");
      process.exitCode = 2;
      return;
    }
    saveConfig({ ...config, bot: enabled.bot }, home);
    console.log(JSON.stringify({ bot: { enabled: true, rooms: enabled.bot.rooms, tier: enabled.bot.tier } }));
    return;
  }
  if (command === "bot" && argv[1] === "disable") {
    const config = loadConfig(home);
    const bot = disableBot(config.bot);
    saveConfig({ ...config, bot }, home);
    console.log(JSON.stringify({ bot: { enabled: false, rooms: bot.rooms } }));
    return;
  }
  if (command === "enroll") {
    const index = argv.indexOf("--enroll");
    const code = argv[index + 1];
    const result = await enroll({ code, home });
    const { ...safe } = result;
    console.log(JSON.stringify(safe));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === "prepare-golden") {
    const config = loadConfig(home);
    if (!config.enabled) saveConfig({ ...config, enabled: true }, home);
    const state = { running: {} };
    const result = await prepareGolden({
      home, state, postNotice: async () => {},
    });
    console.log(JSON.stringify({ ok: result.ok, ownerAction: result.ownerAction, grants: result.grants, message: result.message }));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === "run") {
    const daemon = new MachineDaemon({ home });
    const started = await daemon.start();
    console.log(JSON.stringify(started));
    if (!started.enabled || !started.enrolled) return;
    await new Promise(resolve => {
      process.on("SIGTERM", () => { daemon.stop().then(resolve); });
      process.on("SIGINT", () => { daemon.stop().then(resolve); });
    });
    return;
  }
  console.log("Commands: status, doctor, stop, pause --minutes N, resume, uninstall, provider set NAME, bot enable --room ROOM, bot disable, run");
  process.exitCode = 2;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
