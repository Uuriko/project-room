import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./spawn.mjs";
import { FRAME_INTERVAL_MS, KEYFRAME_MAX, RETENTION_DAYS_DEFAULT, ROOM_FILE_MAX_BYTES } from "./protocol.mjs";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function claimDir(home, claimId) {
  return join(home, "recordings", claimId);
}

export async function captureConsoleFrame(home, claimId, vm) {
  const dir = join(claimDir(home, claimId), "frames");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}.png`;
  const path = join(dir, name);
  const shot = await runCommand("lume", ["screenshot", vm, "--out", path], { timeoutMs: 10_000, maxBytes: 1024 });
  if (shot.code !== 0 || !existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (bytes.length > ROOM_FILE_MAX_BYTES) {
    rmSync(path, { force: true });
    return null;
  }
  return { path, hash: sha256(bytes), bytes };
}

export function appendManifest(home, claimId, entry) {
  const dir = claimDir(home, claimId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, "manifest.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function readManifest(home, claimId) {
  const path = join(claimDir(home, claimId), "manifest.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}

export function keyframes(home, claimId) {
  const dir = join(claimDir(home, claimId), "frames");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(name => name.endsWith(".png")).sort();
  if (files.length <= KEYFRAME_MAX) return files.map(name => join(dir, name));
  const picked = [];
  for (let i = 0; i < KEYFRAME_MAX; i += 1) {
    const index = Math.round(i * (files.length - 1) / (KEYFRAME_MAX - 1));
    picked.push(join(dir, files[index]));
  }
  return [...new Set(picked)];
}

export function startFrameLoop(home, claimId, vm, intervalMs = FRAME_INTERVAL_MS) {
  const timer = setInterval(() => {
    captureConsoleFrame(home, claimId, vm).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function pruneRecordings(home, retentionDays = RETENTION_DAYS_DEFAULT, now = Date.now()) {
  const root = join(home, "recordings");
  if (!existsSync(root)) return [];
  const removed = [];
  const maxAge = retentionDays * 24 * 60 * 60 * 1000;
  for (const claim of readdirSync(root)) {
    const dir = join(root, claim);
    const frames = join(dir, "frames");
    if (!existsSync(frames)) continue;
    for (const name of readdirSync(frames)) {
      const path = join(frames, name);
      const age = now - statSync(path).mtimeMs;
      if (age > maxAge) { rmSync(path, { force: true }); removed.push(path); }
    }
  }
  return removed;
}

export function manifestBytes(home, claimId) {
  const path = join(claimDir(home, claimId), "manifest.jsonl");
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  const bytes = readFileSync(path);
  return bytes.length <= ROOM_FILE_MAX_BYTES ? bytes : bytes.subarray(bytes.length - ROOM_FILE_MAX_BYTES);
}
