import { ERROR, DRIVER_TOOL, FILE_MAX_BYTES, SHELL_OUTPUT_MAX_BYTES, SHELL_TIMEOUT_MS, SCREENSHOT_MAX_BYTES } from "./protocol.mjs";
import { openDriver } from "./mcp.mjs";
import { runCommand } from "./spawn.mjs";
import { startGuest, guestName, snapshotDesk, createScratch } from "./vms.mjs";

const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

// L-3: the SAFE_NAME pattern admits the literal names "." and ".." (and
// other leading-dot segments). They fail closed today — the guest-side
// `cat > .../..` targets a directory and shell metacharacters are excluded —
// but reject them explicitly rather than relying on that.
export function isSafeFileName(name) {
  return typeof name === "string" && SAFE_NAME.test(name) && name !== "." && name !== ".." && !name.startsWith(".");
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

async function ensureSlot(state, slot, claimId, home) {
  if (slot === "desk") {
    if (!state.snapshots) state.snapshots = {};
    if (!state.snapshots[claimId]) state.snapshots[claimId] = await snapshotDesk(claimId);
    return startGuest(state, "desk");
  }
  const name = guestName("scratch", claimId);
  if (!state.running?.[name]) {
    const created = await createScratch(claimId);
    if (!created) return { ok: false, code: ERROR.UNAVAILABLE, message: "scratch clone failed" };
  }
  return startGuest(state, name);
}

function imageBytes(message) {
  const content = message?.result?.content;
  if (!Array.isArray(content)) return null;
  const image = content.find(item => item?.type === "image" && typeof item.data === "string");
  if (!image) return null;
  return Buffer.from(image.data, "base64");
}

export async function dispatchTool({ tool, args = {}, slot, claimId, state, home, allowDriver }) {
  if (tool === "machine.status") {
    return { ok: true, result: {
      halted: state.halted === true,
      pausedUntil: state.pausedUntil,
      deadman: state.deadman === true,
      running: Object.keys(state.running ?? {}),
      slots: state.slots,
    } };
  }
  // Kill-switch gates, mirroring daemon.call(): the autonomous bot reaches
  // dispatchTool directly, so halt/pause/deadman must be enforced here too —
  // otherwise a halted machine's bot keeps acting and re-boots stopped guests.
  if (state?.halted === true) return fail(ERROR.HALTED, "This machine is halted");
  if (state?.pausedUntil && Date.now() < state.pausedUntil) return fail(ERROR.PAUSED, "This machine is paused");
  if (state?.deadman === true) return fail(ERROR.DEADMAN, "Relay link exceeded the dead-man window");
  if (tool === "machine.release") return { ok: true, result: { release: true, claimId, slot } };
  if (tool.startsWith("desktop.")) {
    const driverName = DRIVER_TOOL[tool];
    if (!driverName) return fail(ERROR.TOOL_DENIED, "That desktop tool is not available.");
    const vm = slot === "scratch" ? guestName("scratch", claimId) : "desk";
    const started = await ensureSlot(state, slot, claimId, home);
    if (!started.ok) return fail(started.code, started.message);
    const driver = openDriver(vm);
    try {
      const listed = await driver.initialize();
      if (allowDriver && !allowDriver(listed, driverName)) {
        return fail(ERROR.TOOL_DENIED, "The guest driver did not offer that tool.");
      }
      if (!listed.includes(driverName)) return fail(ERROR.TOOL_DENIED, "The guest driver did not offer that tool.");
      const called = await driver.call(driverName, args);
      const bytes = imageBytes(called);
      if (bytes && bytes.length > SCREENSHOT_MAX_BYTES) return fail(ERROR.TOO_LARGE, "Screenshot exceeds 4 MiB.");
      return { ok: true, result: { tool: driverName, content: called.result?.content ?? null } };
    } catch {
      return fail(ERROR.UNAVAILABLE, "The guest driver did not answer.");
    } finally {
      driver.close();
    }
  }
  if (tool === "shell.vm") {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command || command.length > 4000) return fail(ERROR.INVALID, "command is required");
    const vm = slot === "scratch" ? guestName("scratch", claimId) : "desk";
    const started = await ensureSlot(state, slot, claimId, home);
    if (!started.ok) return fail(started.code, started.message);
    const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.min(Math.max(args.timeoutMs, 100), 120_000) : SHELL_TIMEOUT_MS;
    const ran = await runCommand("lume", ["ssh", vm, "--", "sh", "-c", command], {
      timeoutMs, maxBytes: SHELL_OUTPUT_MAX_BYTES,
    });
    if (ran.timedOut) return fail(ERROR.TIMEOUT, "shell.vm timed out");
    if (ran.capped) return fail(ERROR.OUTPUT_CAPPED, "shell.vm output exceeded the cap");
    return { ok: true, result: { code: ran.code, output: ran.stdout.toString("utf8") } };
  }
  if (tool === "files.put" || tool === "files.get") {
    const name = args.name;
    if (!isSafeFileName(name)) return fail(ERROR.INVALID, "name must be a single path segment");
    const vm = slot === "scratch" ? guestName("scratch", claimId) : "desk";
    const started = await ensureSlot(state, slot, claimId, home);
    if (!started.ok) return fail(started.code, started.message);
    if (tool === "files.put") {
      const bytes = Buffer.from(String(args.data ?? ""), args.encoding === "base64" ? "base64" : "utf8");
      if (bytes.length > FILE_MAX_BYTES) return fail(ERROR.TOO_LARGE, "File exceeds the cap.");
      const wrote = await runCommand("lume", ["ssh", vm, "--", "sh", "-c", `mkdir -p /Users/lume/room-scratch && cat > /Users/lume/room-scratch/${name}`], {
        input: bytes, timeoutMs: 20_000, maxBytes: 1024,
      });
      if (wrote.code !== 0) return fail(ERROR.UNAVAILABLE, "files.put failed");
      return { ok: true, result: { name, bytes: bytes.length } };
    }
    const read = await runCommand("lume", ["ssh", vm, "--", "sh", "-c", `cat /Users/lume/room-scratch/${name}`], {
      timeoutMs: 20_000, maxBytes: FILE_MAX_BYTES + 1,
    });
    if (read.capped) return fail(ERROR.TOO_LARGE, "File exceeds the cap.");
    if (read.code !== 0) return fail(ERROR.UNAVAILABLE, "files.get failed");
    return { ok: true, result: { name, data: read.stdout.toString("base64"), bytes: read.stdout.length } };
  }
  if (tool === "inference.chat") {
    let tags;
    try {
      const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return fail(ERROR.UNAVAILABLE, "Ollama did not answer on 127.0.0.1:11434.");
      tags = await response.json();
    } catch {
      return fail(ERROR.UNAVAILABLE, "Ollama did not answer on 127.0.0.1:11434.");
    }
    const models = Array.isArray(tags.models) ? tags.models.map(model => model.name).filter(Boolean) : [];
    if (!models.includes(args.model)) return fail(ERROR.UNAVAILABLE, `Ollama reported: ${models.join(", ") || "no models"}`);
    try {
      const chat = await fetch("http://127.0.0.1:11434/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: args.model, messages: args.messages ?? [], stream: false }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!chat.ok) return fail(ERROR.UNAVAILABLE, "Ollama chat failed.");
      const value = await chat.json();
      return { ok: true, result: { model: args.model, models, message: value.message ?? null } };
    } catch {
      return fail(ERROR.UNAVAILABLE, "Ollama chat failed.");
    }
  }
  return fail(ERROR.TOOL_DENIED, "That tool is not available.");
}
