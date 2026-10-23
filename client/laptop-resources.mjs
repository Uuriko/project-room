import { availableParallelism, freemem, totalmem, loadavg } from "node:os";
import { statfsSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function observeLaptop(directory, now = Date.now()) {
  const disk = statfsSync(directory);
  let power = "unknown", batteryPercent = null;
  if (process.platform === "darwin") {
    try {
      const output = execFileSync("/usr/bin/pmset", ["-g", "batt"], { encoding: "utf8", timeout: 2000 });
      power = output.includes("'AC Power'") ? "ac" : output.includes("'Battery Power'") ? "battery" : "unknown";
      batteryPercent = Number(/(\d+)%/.exec(output)?.[1] ?? NaN); if (!Number.isFinite(batteryPercent)) batteryPercent = null;
    } catch { /* Unknown power is distinct from AC. */ }
  }
  return { at: now, cpuCount: availableParallelism(), freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(),
    load1: loadavg()[0], freeDiskBytes: disk.bavail * disk.bsize, power, batteryPercent };
}

// A budget is an admission decision, not an OS-enforced memory/CPU sandbox.
// Explicit heavy mode permits all but the owner's reserve when plugged in.
export function laptopBudget(observation, policy, now = Date.now()) {
  if (!observation || !Number.isSafeInteger(observation.at) || observation.at > now || now - observation.at > 30000) return { available: false, reason: "stale_observation" };
  if (policy?.paused) return { available: false, reason: "paused" };
  if (!["balanced", "idle-heavy"].includes(policy?.mode) || !Number.isSafeInteger(policy?.maxJobs) || policy.maxJobs < 1 || policy.maxJobs > 64
    || !Number.isSafeInteger(policy?.memoryPerJobBytes) || policy.memoryPerJobBytes < 64 * 1024 ** 2
    || !Number.isSafeInteger(policy?.reserveMemoryBytes) || policy.reserveMemoryBytes < 512 * 1024 ** 2
    || !Number.isSafeInteger(policy?.reserveDiskBytes) || policy.reserveDiskBytes < 1024 ** 3) throw new Error("Invalid laptop resource policy");
  if (!policy.allowBattery && observation.power !== "ac") return { available: false, reason: "waiting_for_power" };
  if (observation.power === "battery" && (observation.batteryPercent === null || observation.batteryPercent < 25)) return { available: false, reason: "low_battery" };
  if (![observation.cpuCount, observation.freeMemoryBytes, observation.freeDiskBytes, observation.load1].every(Number.isFinite)
    || observation.cpuCount < 1 || observation.freeDiskBytes < policy.reserveDiskBytes) return { available: false, reason: "resources_unavailable" };
  const reserveCpu = policy.mode === "idle-heavy" ? 1 : Math.max(1, Math.ceil(observation.cpuCount / 2));
  const cpuSlots = Math.max(0, Math.floor(observation.cpuCount - reserveCpu - observation.load1));
  const memorySlots = Math.max(0, Math.floor((observation.freeMemoryBytes - policy.reserveMemoryBytes) / policy.memoryPerJobBytes));
  const slots = Math.min(policy.maxJobs, cpuSlots, memorySlots);
  return { available: slots > 0, reason: slots ? "ready" : "busy", slots, mode: policy.mode,
    usableDiskBytes: Math.max(0, observation.freeDiskBytes - policy.reserveDiskBytes), observedAt: observation.at };
}
