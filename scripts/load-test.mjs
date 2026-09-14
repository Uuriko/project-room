// Load test against a local room server. Three measurements, all in-process:
//
//   commands  N concurrent agents doing a realistic work loop over HTTP
//             (presence, post, claim, changes, capabilities).
//   streams   N concurrently open SSE streams while M messages are posted over
//             HTTP; reports per-delivery fan-out latency (post -> arrival on
//             every stream) and any stream the server closed.
//   queue     wake-queue enqueue-to-lease lag through the server/wake-queue.mjs
//             API, with a poller leasing due wakes at a fixed interval.
//
// Usage:
//   node scripts/load-test.mjs [agents=25] [iterations=5]        # commands, legacy flat JSON
//   node scripts/load-test.mjs --mode streams|queue|commands|all [flags]
//
// Flags (safe defaults finish in well under two minutes on a laptop):
//   --streams 50  --messages 200  --message-interval-ms 100  --stream-interval-ms 1000  --settle-ms auto
//   --wakes 200   --wake-interval-ms 5  --poll-ms 50  --lease-batch 32  --wake-members auto
//   --agents 25   --iterations 5
//   --quiet       suppress the human table (stderr); the JSON blob always goes to stdout.
//
// Room guardrails that bound the flags: at most 100 members per room (so at most
// 99 stream members), at most 100 open streams per server and 3 per credential,
// 60 writes per credential per minute, 200 active wakes per member.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const ROOM = "commons";
const MAX_AGENT_MEMBERS = 99; // 100 members per room including the owner

// ---- arguments -------------------------------------------------------------
function parseArgs(argv) {
  const positional = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (name === "quiet") { flags.quiet = true; continue; }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) usage(`Flag ${arg} needs a value`);
    flags[name] = value;
  }
  return { positional, flags };
}
function usage(message) {
  console.error(`${message}\nUsage: node scripts/load-test.mjs [agents] [iterations] | --mode streams|queue|commands|all [--streams N] [--messages N] [--message-interval-ms N] [--stream-interval-ms N] [--settle-ms N] [--wakes N] [--wake-interval-ms N] [--poll-ms N] [--lease-batch N] [--wake-members N] [--agents N] [--iterations N] [--quiet]`);
  process.exit(2);
}
const integer = (value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === "auto") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) usage(`--${name} must be an integer between ${min} and ${max}`);
  return n;
};
const { positional, flags } = parseArgs(process.argv.slice(2));
const KNOWN = ["mode", "streams", "messages", "messageIntervalMs", "streamIntervalMs", "settleMs", "wakes", "wakeIntervalMs", "pollMs", "leaseBatch", "wakeMembers", "agents", "iterations", "quiet"];
for (const name of Object.keys(flags)) if (!KNOWN.includes(name)) usage(`Unknown flag --${name}`);
const legacy = flags.mode === undefined;
const mode = legacy ? "commands" : flags.mode;
if (!["commands", "streams", "queue", "all"].includes(mode)) usage("--mode must be commands, streams, queue or all");
const options = {
  agents: integer(flags.agents ?? positional[0] ?? 25, "agents", { min: 1, max: MAX_AGENT_MEMBERS }),
  iterations: integer(flags.iterations ?? positional[1] ?? 5, "iterations", { min: 1 }),
  streams: integer(flags.streams ?? 50, "streams", { min: 1, max: MAX_AGENT_MEMBERS }),
  messages: integer(flags.messages ?? 200, "messages", { min: 1, max: 5000 }),
  messageIntervalMs: integer(flags.messageIntervalMs ?? 100, "message-interval-ms"),
  streamIntervalMs: integer(flags.streamIntervalMs ?? 1000, "stream-interval-ms", { min: 1 }),
  settleMs: integer(flags.settleMs ?? "auto", "settle-ms"),
  wakes: integer(flags.wakes ?? 200, "wakes", { min: 1, max: 20000 }),
  wakeIntervalMs: integer(flags.wakeIntervalMs ?? 5, "wake-interval-ms"),
  pollMs: integer(flags.pollMs ?? 50, "poll-ms", { min: 1 }),
  leaseBatch: integer(flags.leaseBatch ?? 32, "lease-batch", { min: 1, max: 1000 }),
  wakeMembers: integer(flags.wakeMembers ?? "auto", "wake-members", { min: 1, max: MAX_AGENT_MEMBERS }),
  quiet: flags.quiet === true
};
options.settleMs ??= 3 * options.streamIntervalMs + 2000;
options.wakeMembers ??= Math.min(MAX_AGENT_MEMBERS, Math.ceil(options.wakes / 100));

// ---- statistics ------------------------------------------------------------
const round = n => Math.round(n * 10) / 10;
function percentiles(values) {
  if (!values.length) return { count: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted.at(-1)) };
}
const BUCKETS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
function histogram(values) {
  const counts = new Array(BUCKETS.length + 1).fill(0);
  for (const v of values) { const i = BUCKETS.findIndex(edge => v <= edge); counts[i === -1 ? BUCKETS.length : i]++; }
  return counts.map((count, i) => ({ bucket: i === BUCKETS.length ? `>${BUCKETS.at(-1)}ms` : `<=${BUCKETS[i]}ms`, count }));
}
const table = (title, header, rows) => {
  if (options.quiet) return;
  const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map(r => String(r[i] ?? "").length)));
  const line = cells => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ");
  console.error(`\n${title}\n${line(header)}\n${widths.map(w => "-".repeat(w)).join("  ")}\n${rows.map(line).join("\n")}`);
};
const pctRow = (label, p) => [label, p.count, p.p50 ?? "-", p.p95 ?? "-", p.p99 ?? "-", p.max ?? "-"];
const histRows = h => { const max = Math.max(1, ...h.map(b => b.count)); return h.filter(b => b.count).map(b => [b.bucket, b.count, "#".repeat(Math.ceil(b.count / max * 30))]); };
const countErrors = (errors, e) => errors.set(e.code ?? e.message, (errors.get(e.code ?? e.message) ?? 0) + 1);

// ---- fixture ---------------------------------------------------------------
// One room, one owner, N agent members each holding their own access key so
// the per-credential stream and write limits are never the thing measured.
function openRoom({ members, prefix, workItems = false }) {
  const directory = mkdtempSync(join(tmpdir(), "room-load-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const agents = [];
  for (let i = 0; i < members; i++) {
    const memberId = `${prefix}-${i}`;
    store.command(ownerKey, ROOM, { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"] } });
    if (workItems) store.command(ownerKey, ROOM, { id: randomUUID(), type: T.WORK_PROPOSED, data: {
      workItemId: `load-task-${i}`, title: `Load task ${i}`, definitionOfDone: "Claimed and completed under load",
      accountableMemberId: memberId, mode: "read" } });
    agents.push({ memberId, key: store.issueAccessKey(ROOM, memberId) });
  }
  return { directory, store, ownerKey, agents, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function startServer(store, serverOptions = {}) {
  const server = createRoomServer({ store, ...serverOptions });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, stop: async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}

// ---- commands (unchanged behaviour) ------------------------------------------
async function runCommands({ agents: AGENTS, iterations: ITERS }) {
  const room = openRoom({ members: AGENTS, prefix: "load-agent", workItems: true });
  const { origin, stop } = await startServer(room.store);
  const latencies = [], errors = new Map();
  let ops = 0;
  const time = async label => {
    const start = performance.now();
    try { const r = await label(); latencies.push(performance.now() - start); ops++; return r; }
    catch (e) { latencies.push(performance.now() - start); countErrors(errors, e); }
  };
  async function agentLoop({ memberId, key }) {
    const c = new RoomAgentClient({ version: 1, origin, roomId: ROOM, memberId, token: key });
    for (let i = 0; i < ITERS; i++) {
      await time(() => c.presence());
      await time(() => c.command({ id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: `load ping ${i} from ${memberId}` } }));
      await time(() => c.claimSession(`load-task-${Math.floor(Math.random() * AGENTS)}`)).catch(() => {});
      await time(() => c.changes(0, 20));
      await time(() => c.capabilities());
    }
  }
  const wallStart = performance.now();
  await Promise.all(room.agents.map(agentLoop));
  const wallMs = performance.now() - wallStart;
  await stop(); room.close();
  latencies.sort((a, b) => a - b);
  const pct = p => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(1);
  const result = {
    agents: AGENTS, iterations: ITERS, wallMs: Math.round(wallMs),
    ops, opsPerSec: Math.round(ops / (wallMs / 1000)),
    latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: pct(1) },
    errors: Object.fromEntries(errors)
  };
  table(`commands: ${AGENTS} agents x ${ITERS} iterations, ${ops} ops in ${result.wallMs}ms (${result.opsPerSec} ops/s)`,
    ["metric", "count", "p50", "p95", "p99", "max"], [["command latency ms", ops, ...Object.values(result.latencyMs)]]);
  return result;
}

// ---- streams -----------------------------------------------------------------
// Minimal SSE parser: blocks end at a blank line; comment lines start with ':'.
function* sseBlocks(buffer) {
  let index;
  while ((index = buffer.text.indexOf("\n\n")) !== -1) {
    const block = buffer.text.slice(0, index); buffer.text = buffer.text.slice(index + 2);
    const message = { event: "message", data: "" };
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon), value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") message.event = value; else if (field === "data") message.data += (message.data ? "\n" : "") + value;
    }
    if (block.trim()) yield message;
  }
}
async function runStreams({ streams: STREAMS, messages: MESSAGES, messageIntervalMs, streamIntervalMs, settleMs }) {
  const room = openRoom({ members: STREAMS, prefix: "stream-agent" });
  const { origin, stop } = await startServer(room.store, { streamInterval: streamIntervalMs });
  const after = room.store.room(ROOM).sequence;
  const pending = new Map(); // messageId -> performance.now() just before the POST
  const delivery = [], openMs = [], postMs = [];
  const openFailures = new Map(), postErrors = new Map();
  const closedByServer = [], accessEnded = [];
  let received = 0, unexpected = 0, finished = false;
  const controllers = [];

  async function openStream(index, { key }) {
    const controller = new AbortController(); controllers.push(controller);
    const start = performance.now();
    let response;
    try {
      response = await fetch(`${origin}/api/rooms/${ROOM}/stream?after=${after}`, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
    } catch (e) { openFailures.set(e.name ?? "fetch_failed", (openFailures.get(e.name ?? "fetch_failed") ?? 0) + 1); return null; }
    if (response.status !== 200) {
      const code = (await response.json().catch(() => ({}))).error?.code ?? `http_${response.status}`;
      openFailures.set(code, (openFailures.get(code) ?? 0) + 1); return null;
    }
    openMs.push(performance.now() - start);
    const reader = response.body.getReader();
    const decoder = new TextDecoder(), buffer = { text: "" };
    const consume = async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { if (!finished) closedByServer.push(index); return; }
          buffer.text += decoder.decode(value, { stream: true });
          for (const message of sseBlocks(buffer)) {
            if (message.event === "access-ended") { accessEnded.push(index); continue; }
            if (message.event !== "room-event") continue;
            const item = JSON.parse(message.data);
            if (item.event?.type !== T.MESSAGE_POSTED) continue;
            const sentAt = pending.get(item.event.data?.messageId);
            if (sentAt === undefined) { unexpected++; continue; }
            delivery.push(performance.now() - sentAt); received++;
          }
        }
      } catch (e) { if (!finished && e.name !== "AbortError") closedByServer.push(index); }
    };
    return { consumer: consume() };
  }

  const wallStart = performance.now();
  // openStream resolves once the response headers arrive; the consumer promise
  // it hands back settles only when the stream ends, so it is collected, not awaited.
  const consumers = (await Promise.all(room.agents.map((agent, index) => openStream(index, agent)))).filter(Boolean).map(opened => opened.consumer);
  const open = consumers.length;
  const openedMs = performance.now() - wallStart;
  const posters = room.agents.map(({ memberId, key }) => new RoomAgentClient({ version: 1, origin, roomId: ROOM, memberId, token: key }));
  let posted = 0;
  for (let i = 0; i < MESSAGES; i++) {
    const messageId = randomUUID(), poster = posters[i % posters.length], start = performance.now();
    pending.set(messageId, start);
    try {
      await poster.command({ id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body: `fan-out ${i}` } });
      postMs.push(performance.now() - start); posted++;
    } catch (e) { pending.delete(messageId); countErrors(postErrors, e); }
    const nextAt = start + messageIntervalMs;
    if (i + 1 < MESSAGES && nextAt > performance.now()) await sleep(nextAt - performance.now());
  }
  const postedMs = performance.now() - wallStart;
  const expected = posted * open;
  const settleStart = performance.now();
  while (received < expected && performance.now() - settleStart < settleMs) await sleep(Math.min(20, streamIntervalMs));
  finished = true;
  const wallMs = performance.now() - wallStart;
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(consumers);
  await stop(); room.close();

  const result = {
    streamsRequested: STREAMS, streamsOpen: open, openFailures: Object.fromEntries(openFailures),
    streamIntervalMs, messageIntervalMs, settleMs,
    messages: MESSAGES, posted, postErrors: Object.fromEntries(postErrors),
    deliveries: { expected, received, missing: expected - received, unexpected },
    closedByServer: { count: closedByServer.length, streams: closedByServer.slice(0, 20) },
    accessEnded: accessEnded.length,
    streamOpenMs: percentiles(openMs), postMs: percentiles(postMs), deliveryLatencyMs: percentiles(delivery),
    deliveryHistogram: histogram(delivery),
    wallMs: Math.round(wallMs), openedMs: Math.round(openedMs), postedMs: Math.round(postedMs)
  };
  table(`streams: ${open}/${STREAMS} open, ${posted}/${MESSAGES} posted every ${messageIntervalMs}ms, pump ${streamIntervalMs}ms; delivered ${received}/${expected}, closed by server ${closedByServer.length}, wall ${result.wallMs}ms`,
    ["metric", "count", "p50", "p95", "p99", "max"],
    [pctRow("stream open ms", result.streamOpenMs), pctRow("post ms", result.postMs), pctRow("delivery latency ms", result.deliveryLatencyMs)]);
  table("delivery latency histogram", ["bucket", "count", ""], histRows(result.deliveryHistogram));
  return result;
}

// ---- queue -------------------------------------------------------------------
async function runQueue({ wakes: WAKES, wakeIntervalMs, pollMs, leaseBatch, wakeMembers }) {
  const room = openRoom({ members: wakeMembers, prefix: "wake-agent" });
  const queue = room.store.wakeQueue;
  const pending = new Map(); // `${memberId}/${queueKey}` -> performance.now() before enqueue
  const lag = [], enqueueMs = [], leaseMs = [], completeMs = [];
  const errors = new Map();
  let enqueued = 0, leased = 0, completed = 0, maxBacklog = 0, polls = 0;
  const wallStart = performance.now();
  let producing = true;
  const producer = (async () => {
    try { for (let i = 0; i < WAKES; i++) {
      const { memberId, key } = room.agents[i % room.agents.length];
      const queueKey = `load-wake-${i}`, start = performance.now();
      pending.set(`${memberId}/${queueKey}`, start);
      try {
        queue.enqueue(key, ROOM, { requestId: randomUUID(), queueKey, intent: { load: i }, dueAt: Date.now(), maxAttempts: 3 });
        enqueueMs.push(performance.now() - start); enqueued++;
      } catch (e) { pending.delete(`${memberId}/${queueKey}`); countErrors(errors, e); }
      if (wakeIntervalMs > 0 && i + 1 < WAKES) await sleep(wakeIntervalMs);
      else if (i % 50 === 49) await sleep(0); // let the poller run in burst mode
    } } finally { producing = false; }
  })();
  const worker = randomUUID();
  const deadline = performance.now() + 120000;
  while ((producing || leased < enqueued) && performance.now() < deadline) {
    await sleep(pollMs); polls++;
    const due = queue.due(Date.now(), leaseBatch);
    maxBacklog = Math.max(maxBacklog, due.length);
    for (const wake of due) {
      const memberId = wakeMember(wake, room);
      if (!memberId) continue;
      const start = performance.now();
      const row = queue.lease(ROOM, memberId, wake.queueKey, worker);
      if (!row) continue;
      const leasedAt = performance.now(); leaseMs.push(leasedAt - start); leased++;
      const sentAt = pending.get(`${memberId}/${wake.queueKey}`);
      if (sentAt !== undefined) lag.push(leasedAt - sentAt);
      try { queue.complete(ROOM, memberId, wake.queueKey, { requestId: randomUUID(), leaseOwner: worker }); completeMs.push(performance.now() - leasedAt); completed++; }
      catch (e) { countErrors(errors, e); }
    }
  }
  const wallMs = performance.now() - wallStart;
  await producer; room.close();
  const result = {
    wakes: WAKES, wakeMembers, wakeIntervalMs, pollMs, leaseBatch,
    enqueued, leased, completed, unleased: enqueued - leased, polls, maxDueBacklog: maxBacklog,
    errors: Object.fromEntries(errors),
    enqueueMs: percentiles(enqueueMs), leaseMs: percentiles(leaseMs), completeMs: percentiles(completeMs),
    lagMs: percentiles(lag), lagHistogram: histogram(lag), wallMs: Math.round(wallMs)
  };
  table(`queue: ${enqueued}/${WAKES} enqueued every ${wakeIntervalMs}ms across ${wakeMembers} member(s), poller every ${pollMs}ms x ${leaseBatch}; leased ${leased}, completed ${completed}, max due backlog ${maxBacklog}, wall ${result.wallMs}ms`,
    ["metric", "count", "p50", "p95", "p99", "max"],
    [pctRow("enqueue ms", result.enqueueMs), pctRow("lease ms", result.leaseMs), pctRow("complete ms", result.completeMs), pctRow("enqueue->lease lag ms", result.lagMs)]);
  table("enqueue->lease lag histogram", ["bucket", "count", ""], histRows(result.lagHistogram));
  return result;
}
// due() rows are member-scoped views without the member id; wakes are keyed
// per member here so the owning member can be recovered from the queue key.
function wakeMember(wake, room) {
  const index = Number(/^load-wake-(\d+)$/.exec(wake.queueKey)?.[1]);
  return Number.isInteger(index) ? room.agents[index % room.agents.length].memberId : null;
}

// ---- main ----------------------------------------------------------------------
const startedAt = new Date().toISOString();
let output;
if (legacy) { options.quiet = true; output = await runCommands(options); } // legacy output: the flat JSON blob only
else {
  const { quiet, ...reported } = options;
  output = { mode, node: process.version, startedAt, options: reported };
  if (mode === "commands" || mode === "all") output.commands = await runCommands(options);
  if (mode === "streams" || mode === "all") output.streams = await runStreams(options);
  if (mode === "queue" || mode === "all") output.queue = await runQueue(options);
}
console.log(JSON.stringify(output, null, 2));
// Idle fetch keep-alive sockets can outlive the server; do not let them hold the process.
setTimeout(() => process.exit(0), 3000).unref();
