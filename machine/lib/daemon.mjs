import { spawnContext } from "./spawn.mjs";
import { machineEnabled, DAEMON_VERSION } from "./flags.mjs";
import {
  APPROVAL_TTL_MS, DEADMAN_DEFAULT_SECONDS, ERROR, MUTATING_DESKTOP, PROTOCOL_VERSION,
  RECEIPT_BLOB_MAX, SCREENSHOT_MAX_BYTES, SLOTS, TAG_PATTERN, errorResult, okResult,
} from "./protocol.mjs";
import { configHome, loadConfig, saveConfig } from "./config.mjs";
import { readSecret } from "./secrets.mjs";
import { connectSocket } from "./ws.mjs";
import { dispatchTool } from "./tools.mjs";
import { approvalClass, requestApproval, takeApproval } from "./approvals.mjs";
import {
  appendManifest, captureConsoleFrame, keyframes, manifestBytes, pruneRecordings, sha256, startFrameLoop,
} from "./recording.mjs";
import { identitySecret, stageFile, updateClaim } from "./room.mjs";
import { deleteGuest, guestName, stopAllGuests, suspendGuests } from "./vms.mjs";

function machineTag(label) {
  const body = String(label || "host").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "host";
  const tag = `machine-${body}`.slice(0, 32);
  return TAG_PATTERN.test(tag) ? tag : "machine-host";
}

function slotTag(slot) {
  const tag = `slot-${slot}`.slice(0, 32);
  return TAG_PATTERN.test(tag) ? tag : "slot-desk";
}

export class MachineDaemon {
  constructor({ home, env = process.env } = {}) {
    this.home = home ?? configHome(env);
    this.env = env;
    this.config = loadConfig(this.home);
    this.state = {
      running: {},
      slots: { desk: this.config.slots?.desk ?? null, scratch: this.config.slots?.scratch ?? null },
      halted: this.config.halted === true,
      pausedUntil: this.config.pausedUntil ?? null,
      deadman: false,
      snapshots: {},
    };
    this.stopped = false;
    this.lastInbound = 0;
    this.socket = null;
    this.queue = Promise.resolve();
    this.frameStops = new Map();
    this.connections = 0;
  }

  featureOn() {
    return machineEnabled(this.env) && this.config.enabled === true;
  }

  deadmanMs() {
    const fromEnv = Number(this.env.ROOM_MACHINE_DEADMAN_SECONDS);
    const seconds = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : (this.config.deadmanSeconds || DEADMAN_DEFAULT_SECONDS);
    return seconds * 1000;
  }

  async start() {
    if (!this.featureOn()) return { enabled: false };
    pruneRecordings(this.home, this.config.retentionDays);
    const token = await readSecret("machine", this.home);
    if (!token || !this.config.relayUrl) return { enabled: true, enrolled: false };
    this.token = token;
    this.timer = setInterval(() => {
      spawnContext.run({ env: this.env }, () => { this.tick().catch(() => {}); });
    }, 200);
    this.timer.unref?.();
    this.connectLoop();
    return { enabled: true, enrolled: true };
  }

  async tick() {
    if (!this.lastInbound || this.stopped) return;
    if (Date.now() - this.lastInbound < this.deadmanMs()) return;
    if (!this.state.deadman) {
      this.state.deadman = true;
      await suspendGuests(this.state);
    }
  }

  connectLoop() {
    const step = async () => {
      if (this.stopped) return;
      await new Promise(resolve => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        this.socket = connectSocket(this.config.relayUrl, {
          headers: { Authorization: `Bearer ${this.token}` },
          onOpen: () => {
            this.connections += 1;
            this.lastInbound = Date.now();
            this.socket.send(JSON.stringify({
              type: "hello", protocol: PROTOCOL_VERSION, machineId: this.config.machineId,
              label: this.config.label, version: DAEMON_VERSION,
            }));
          },
          onText: text => {
            this.queue = this.queue.then(() => spawnContext.run({ env: this.env }, () => this.handleRaw(text))).catch(() => {});
          },
          onClose: done,
        });
      });
      if (this.stopped) return;
      await new Promise(resolve => setTimeout(resolve, this.config.reconnectBackoffMs || 1000));
      return step();
    };
    this.loop = step();
  }

  async handleRaw(text) {
    const gap = this.lastInbound ? Date.now() - this.lastInbound : 0;
    const tripped = this.lastInbound > 0 && gap > this.deadmanMs();
    this.lastInbound = Date.now();
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (!message || typeof message.type !== "string") return;
    if (tripped) {
      this.state.deadman = true;
      await suspendGuests(this.state);
    }
    if (message.type === "heartbeat" || message.type === "hello") {
      this.state.deadman = false;
      return;
    }
    if (message.type === "halt") {
      this.state.halted = true;
      this.state.deadman = false;
      this.config.halted = true;
      this.config.haltEpoch = Number(message.epoch) || this.config.haltEpoch + 1;
      saveConfig(this.config, this.home);
      await stopAllGuests(this.state);
      return;
    }
    if (message.type === "pause") {
      const minutes = Number(message.minutes) || 0;
      this.state.pausedUntil = Date.now() + minutes * 60 * 1000;
      await suspendGuests(this.state);
      return;
    }
    if (message.type === "resume") {
      this.state.halted = false;
      this.state.pausedUntil = null;
      this.config.halted = false;
      saveConfig(this.config, this.home);
      return;
    }
    if (message.type === "bye") return;
    if (message.type !== "call") return;
    const result = await this.call(message);
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) > SCREENSHOT_MAX_BYTES) {
      this.socket?.send(JSON.stringify(errorResult(message.id, ERROR.TOO_LARGE, "Result exceeds 4 MiB.")));
      return;
    }
    this.socket?.send(encoded);
  }

  async call(message) {
    const id = message.id;
    if (!this.featureOn()) return errorResult(id, ERROR.DISABLED, "room-machine is off");
    if (this.state.halted) return errorResult(id, ERROR.HALTED, "This machine is halted");
    if (this.state.pausedUntil && Date.now() < this.state.pausedUntil) return errorResult(id, ERROR.PAUSED, "This machine is paused");
    if (this.state.deadman) return errorResult(id, ERROR.DEADMAN, "Relay link exceeded the dead-man window");
    const caller = message.caller;
    if (!caller || caller.verified !== true || typeof caller.identityId !== "string"
      || typeof caller.claimId !== "string" || !SLOTS.includes(caller.slot)) {
      return errorResult(id, ERROR.LEASE_REQUIRED, "A verified lease is required");
    }
    const held = this.state.slots[caller.slot];
    if (held && held.claimId !== caller.claimId) {
      return errorResult(id, ERROR.SLOT_HELD, "Another lease holds this slot");
    }
    this.state.slots[caller.slot] = { claimId: caller.claimId, identityId: caller.identityId };
    const tool = message.tool;
    const allow = new Set(this.config.allow ?? []);
    if (!allow.has(tool)) return errorResult(id, ERROR.TOOL_DENIED, "Policy does not allow that tool");
    const className = approvalClass({ tool, slot: caller.slot, args: message.args ?? {} });
    if (className) {
      const secret = await identitySecret(this.home);
      const requested = await requestApproval({
        home: this.home, origin: this.config.roomOrigin, roomId: this.config.roomId, secret,
        ownerMemberId: this.config.ownerMemberId, className, detail: `${caller.identityId} ${className}`,
      });
      if (!requested.ok) return errorResult(id, ERROR.APPROVAL_REQUIRED, "Approval could not be posted");
      const waitMs = Number(this.env.ROOM_MACHINE_APPROVAL_WAIT_MS);
      const budget = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : APPROVAL_TTL_MS;
      const deadline = Date.now() + budget;
      let taken = { ok: false, reason: ERROR.APPROVAL_REQUIRED };
      while (Date.now() <= deadline) {
        taken = await takeApproval({
          home: this.home, origin: this.config.roomOrigin, roomId: this.config.roomId, secret, code: requested.code,
        });
        if (taken.ok || taken.reason === ERROR.APPROVAL_DENIED) break;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      if (!taken.ok) return errorResult(id, taken.reason, "The owner has not approved this");
    }
    if (caller.slot && !this.frameStops.has(caller.claimId) && tool.startsWith("desktop.")) {
      const vm = guestName(caller.slot, caller.claimId);
      this.frameStops.set(caller.claimId, startFrameLoop(this.home, caller.claimId, vm));
    }
    const dispatched = await dispatchTool({
      tool, args: message.args ?? {}, slot: caller.slot, claimId: caller.claimId, state: this.state, home: this.home,
    });
    if (!dispatched.ok) return errorResult(id, dispatched.error.code, dispatched.error.message);
    if (MUTATING_DESKTOP.has(tool)) {
      const vm = guestName(caller.slot, caller.claimId);
      const frame = await captureConsoleFrame(this.home, caller.claimId, vm);
      appendManifest(this.home, caller.claimId, {
        at: new Date().toISOString(),
        tool,
        args: message.args ?? {},
        resultHash: sha256(Buffer.from(JSON.stringify(dispatched.result))),
        frameHash: frame?.hash ?? null,
      });
    }
    if (tool === "machine.release") {
      const receipt = await this.closeReceipt(caller);
      this.frameStops.get(caller.claimId)?.();
      this.frameStops.delete(caller.claimId);
      this.state.slots[caller.slot] = null;
      if (caller.slot === "scratch") await deleteGuest(this.state, guestName("scratch", caller.claimId));
      return okResult(id, receipt);
    }
    return okResult(id, dispatched.result);
  }

  async closeReceipt(caller) {
    const secret = await identitySecret(this.home);
    const frames = keyframes(this.home, caller.claimId);
    const blobs = [];
    const manifest = manifestBytes(this.home, caller.claimId);
    const stagedManifest = await stageFile(this.config.roomOrigin, this.config.roomId, secret, {
      filename: "manifest.jsonl", mediaType: "text/plain", bytes: manifest,
    });
    if (stagedManifest.ok) blobs.push(stagedManifest.blob);
    for (const [index, path] of frames.entries()) {
      if (blobs.length >= RECEIPT_BLOB_MAX) break;
      const { readFileSync } = await import("node:fs");
      const bytes = readFileSync(path);
      const staged = await stageFile(this.config.roomOrigin, this.config.roomId, secret, {
        filename: `frame-${index}.png`, mediaType: "image/png", bytes,
      });
      if (staged.ok) blobs.push(staged.blob);
    }
    const tags = [machineTag(this.config.label), "lease", slotTag(caller.slot)].filter(tag => TAG_PATTERN.test(tag)).slice(0, 10);
    const limited = blobs.slice(0, RECEIPT_BLOB_MAX);
    const progressed = await updateClaim(this.config.roomOrigin, this.config.roomId, secret, caller.claimId, { state: "in_progress" });
    if (!progressed.ok) return { blobs: limited, tags, closed: false, status: progressed.status };
    const done = await updateClaim(this.config.roomOrigin, this.config.roomId, secret, caller.claimId, {
      state: "done",
      deliveryMode: "result",
      tags,
      blobs: limited,
      note: `lease receipt blobs ${limited.length}`,
    });
    return { blobs: limited, tags, closed: done.ok, status: done.status };
  }

  async pause(minutes) {
    this.state.pausedUntil = Date.now() + minutes * 60 * 1000;
    await suspendGuests(this.state);
    return { pausedUntil: this.state.pausedUntil };
  }

  async resume() {
    this.state.halted = false;
    this.state.pausedUntil = null;
    this.config.halted = false;
    saveConfig(this.config, this.home);
    return { halted: false };
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const stop of this.frameStops.values()) stop();
    this.frameStops.clear();
    await stopAllGuests(this.state);
    this.socket?.close();
  }

  status() {
    return {
      enabled: this.featureOn(),
      halted: this.state.halted,
      pausedUntil: this.state.pausedUntil,
      deadman: this.state.deadman,
      enrolled: Boolean(this.config.machineId),
      running: Object.keys(this.state.running),
      slots: this.state.slots,
      connections: this.connections,
    };
  }
}
