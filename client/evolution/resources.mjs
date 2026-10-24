import { statfsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { availableParallelism, freemem, loadavg } from 'node:os';

let pressureCache;
function memoryPressure() {
  if (process.platform !== 'darwin') return 'unsupported';
  if (pressureCache && Date.now() - pressureCache.at < 1000) return pressureCache.value;
  let value = 'unavailable';
  try {
    const level = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'],
      { encoding: 'utf8', timeout: 500, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    value = { 1: 'normal', 2: 'warning', 4: 'critical' }[level] ?? 'unavailable';
  } catch { /* Required guards fail closed when telemetry is unavailable. */ }
  pressureCache = { at: Date.now(), value }; return value;
}
export function observeResources(directory) {
  let diskAvailableBytes = null;
  if (directory) {
    try {
      const fs = statfsSync(directory, { bigint: true });
      const bytes = fs.bavail * fs.bsize;
      if (bytes >= 0n && bytes <= BigInt(Number.MAX_SAFE_INTEGER)) diskAvailableBytes = Number(bytes);
    } catch { /* Never substitute free space on an unrelated filesystem. */ }
  }
  return { at: Date.now(), cpuSlots: Math.max(0, availableParallelism() - Math.ceil(loadavg()[0])),
    memoryBytes: freemem(), diskAvailableBytes, memoryPressure: memoryPressure() };
}
export function resourceGate(policy, observation, now = Date.now()) {
  if (!Number.isSafeInteger(observation?.at) || observation.at > now || now - observation.at > 30000
    || !Number.isFinite(observation.cpuSlots) || observation.cpuSlots < 0
    || !Number.isFinite(observation.memoryBytes) || observation.memoryBytes < 0)
    return { allowed: false, reason: 'stale_resources' };
  if ((policy.reserveDiskBytes ?? 0) > 0) {
    if (!Number.isSafeInteger(observation.diskAvailableBytes) || observation.diskAvailableBytes < 0)
      return { allowed: false, reason: 'disk_observation_unavailable' };
    if (observation.diskAvailableBytes < policy.reserveDiskBytes) return { allowed: false, reason: 'disk_headroom' };
  }
  if (policy.requireNormalMemoryPressure) {
    if (!['normal', 'warning', 'critical'].includes(observation.memoryPressure))
      return { allowed: false, reason: 'memory_pressure_unavailable' };
    if (observation.memoryPressure !== 'normal') return { allowed: false, reason: 'memory_pressure' };
  }
  return { allowed: true };
}
