// Link-time control checks without miniflare: the pure frame choice, then the
// Durable Object's hello path with cloudflare:workers stubbed, so a halt or
// pause issued while the machine was offline is proven to reach the daemon.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { controlFrameOnLink } from "../src/protocol.mjs";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== "cloudflare:workers") return next(specifier, context);
    return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true };
  },
});
const { MachineLink } = await import("../src/machine-link.mjs");

const now = 1_700_000_000_000;

test("a daemon that links while halted hears the halt with the current epoch", () => {
  assert.deepEqual(controlFrameOnLink({ halted: true, haltEpoch: 3, pausedUntil: now + 60_000 }, now), { type: "halt", epoch: 3 });
});

test("a daemon that links mid-pause hears the remaining minutes, rounded up", () => {
  assert.deepEqual(controlFrameOnLink({ halted: false, haltEpoch: 0, pausedUntil: now + 90_000 }, now), { type: "pause", minutes: 2 });
  assert.deepEqual(controlFrameOnLink({ halted: false, haltEpoch: 0, pausedUntil: now + 1 }, now), { type: "pause", minutes: 1 });
});

test("nothing is replayed for a free machine, an expired pause, or a resume", () => {
  assert.equal(controlFrameOnLink({ halted: false, haltEpoch: 2, pausedUntil: null }, now), null);
  assert.equal(controlFrameOnLink({ halted: false, haltEpoch: 2, pausedUntil: now }, now), null);
  assert.equal(controlFrameOnLink(null, now), null);
});

async function hello(state, machineId = "m1") {
  const stored = new Map([["machine", state]]);
  const ctx = {
    storage: { get: async key => stored.get(key), put: async (key, value) => { stored.set(key, structuredClone(value)); } },
    getWebSockets: () => [],
  };
  const link = new MachineLink(ctx, {});
  const frames = [];
  const ws = { send: text => frames.push(JSON.parse(text)), close: code => frames.push({ closed: code }) };
  await link.webSocketMessage(ws, JSON.stringify({ type: "hello", protocol: 1, machineId, label: "Desk", version: "0.1.0" }));
  return frames;
}

test("the relay replays a halt or pause from while the daemon was offline when it says hello", async () => {
  const base = { machineId: "m1", haltEpoch: 0, halted: false, pausedUntil: null };
  assert.deepEqual(await hello({ ...base, halted: true, haltEpoch: 4 }), [{ type: "halt", epoch: 4 }]);
  const [pause] = await hello({ ...base, pausedUntil: Date.now() + 30 * 60_000 });
  assert.equal(pause.type, "pause");
  assert.ok(pause.minutes === 30 || pause.minutes === 29, `pause replayed as ${pause.minutes} minutes`);
  assert.deepEqual(await hello({ ...base }), []);
  assert.deepEqual(await hello({ ...base, halted: true }, "someone-else"), [{ closed: 1002 }], "a refused hello hears no control");
});
