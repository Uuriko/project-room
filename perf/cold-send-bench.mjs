// Cold load and one own send, same flags every run.
// Prints one JSON line: coldLoad (median ms, request count, JS bytes) and ownSend (median ms).
// Node's fetch against a throwaway local server. No browser, no prod.
// This file is perf/cold-send-bench.mjs. perf/interaction-bench.mjs is the
// room-switch, channel-switch, search, and DOM bench and is a different program.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const samples = Number(process.env.COLD_SEND_BENCH_SAMPLES || process.env.INTERACTION_BENCH_SAMPLES || 5);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function boot() {
  const directory = mkdtempSync(join(tmpdir(), "cold-send-bench-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const token = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, token,
    async close() {
      server.closeStreams?.();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function coldLoad(origin) {
  const started = performance.now();
  const home = await fetch(`${origin}/`);
  const html = await home.text();
  const assets = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map(match => new URL(match[1], `${origin}/`).href);
  let jsBytes = 0;
  const bodies = await Promise.all(assets.map(async url => {
    const response = await fetch(url);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (url.endsWith(".js") || url.endsWith(".mjs")) jsBytes += bytes.length;
    return response.status;
  }));
  return {
    ms: performance.now() - started,
    requests: 1 + assets.length,
    jsBytes,
    homeStatus: home.status,
    assetStatus: bodies
  };
}

async function ownSend(origin, token, n) {
  const started = performance.now();
  const response = await fetch(`${origin}/api/rooms/commons/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      id: `perf-send-${n}`,
      type: "message.posted",
      data: { messageId: `perf-msg-${n}`, body: "hello" }
    })
  });
  await response.json();
  return { ms: performance.now() - started, status: response.status };
}

const room = await boot();
try {
  const cold = [];
  const send = [];
  for (let n = 0; n < samples; n += 1) {
    cold.push(await coldLoad(room.origin));
    send.push(await ownSend(room.origin, room.token, n));
  }
  const report = {
    node: process.version,
    samples,
    coldLoad: {
      ms: median(cold.map(row => row.ms)),
      requests: cold[0].requests,
      jsBytes: cold[0].jsBytes,
      homeStatus: cold[0].homeStatus,
      assetStatus: cold[0].assetStatus
    },
    ownSend: {
      ms: median(send.map(row => row.ms)),
      status: send[0].status
    }
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await room.close();
}
