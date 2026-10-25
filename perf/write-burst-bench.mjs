// Throwaway local write burst. Never points at a deployed room.
//
// Starts a Room server on 127.0.0.1, posts from N distinct members at once,
// and prints one JSON line:
//
//   {"writes/s":N,"p50Ms":N,"p95Ms":N,"p99Ms":N,"rowBytes":N,...}
//
// `rowBytes` is length(CAST(rooms.projection AS BLOB)) after the burst, the
// same byte length the 4 MiB cap compares. Seed posts run before the timer,
// through store.command, from members who do not take part in the burst.
// Each member stays inside the chat flood burst of 30.
//
//   node perf/write-burst-bench.mjs --writers 8 --each 5 --seed 1000
//   node perf/write-burst-bench.mjs --writers 8 --each 5 --seed 1000 --side-table --defer-release
//
// --side-table and --defer-release are the hosted-object switches from
// #4843 and #4842. A store that has no such option reports the flag false.
//
// The smoke test is perf/write-burst-bench.test.mjs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PILOT_LIMITS, RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const ROOM_ID = "commons";
const SEED_PER_AUTHOR = 20;
const FLOOD_BURST = 30;
const BODY_CHARS = 600;

export function percentile(samples, p) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("percentile needs at least one sample");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function bodyFor(label) {
  const word = "verified projection sequence stays on this room row ";
  let text = `${label} `;
  while (text.length < BODY_CHARS) text += word;
  return text.slice(0, BODY_CHARS);
}

function rowBytes(store) {
  const row = store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS n FROM rooms WHERE id=?").get(ROOM_ID);
  return Number(row?.n ?? 0);
}

function memberCount(writers, seed) {
  const seedAuthors = seed === 0 ? 0 : Math.ceil(seed / SEED_PER_AUTHOR);
  return { seedAuthors, members: 1 + writers + seedAuthors };
}

export async function runWriteBurst({ writers = 4, each = 4, seed = 0, sideTableMessages = false, deferBodyRelease = false } = {}) {
  if (!Number.isInteger(writers) || writers < 1) throw new Error("--writers must be an integer >= 1");
  if (!Number.isInteger(each) || each < 1 || each > FLOOD_BURST) throw new Error(`--each must be an integer from 1 to ${FLOOD_BURST}`);
  if (!Number.isInteger(seed) || seed < 0) throw new Error("--seed must be an integer >= 0");
  const { seedAuthors, members } = memberCount(writers, seed);
  if (members > PILOT_LIMITS.membersPerRoom) {
    throw new Error(`writers plus seed authors need ${members} members; the room cap is ${PILOT_LIMITS.membersPerRoom}`);
  }

  const directory = mkdtempSync(join(tmpdir(), "room-write-burst-"));
  const store = new RoomStore(join(directory, "room.sqlite"), {
    ...(sideTableMessages ? { sideTableMessages: true } : {}),
    ...(deferBodyRelease ? { deferBodyRelease: true } : {})
  });
  let server;
  try {
    store.initialize(initialRoom(ROOM_ID));
    const owner = store.issueAccessKey(ROOM_ID, "owner");
    const add = (memberId, commandId) => {
      store.command(owner, ROOM_ID, {
        id: commandId,
        type: "member.added",
        data: { memberId, displayName: memberId, kind: "agent", permissions: [] }
      });
      return store.issueAccessKey(ROOM_ID, memberId);
    };
    const writerKeys = [];
    for (let i = 0; i < writers; i++) writerKeys.push(add(`writer${i}`, `member-writer-${i}`));
    const seedKeys = [];
    for (let i = 0; i < seedAuthors; i++) seedKeys.push(add(`seeder${i}`, `member-seeder-${i}`));
    for (let n = 0; n < seed; n++) {
      const key = seedKeys[n % seedKeys.length];
      store.command(key, ROOM_ID, {
        id: `seed-${n}`,
        type: "message.posted",
        data: { messageId: `seed-m${n}`, body: bodyFor(`seed ${n}`) }
      });
    }
    const before = rowBytes(store);
    server = createRoomServer({ store });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = async (token, n, writer) => {
      const started = performance.now();
      const response = await fetch(`${origin}/api/rooms/${ROOM_ID}/commands`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          id: `burst-${writer}-${n}`,
          type: "message.posted",
          data: { messageId: `burst-m${writer}-${n}`, body: bodyFor(`burst ${writer} ${n}`) }
        })
      });
      const elapsed = performance.now() - started;
      const payload = await response.json().catch(() => null);
      return { status: response.status, ms: elapsed, code: response.status === 201 ? null : payload?.code ?? null };
    };

    const wallStart = performance.now();
    const results = await Promise.all(writerKeys.map((token, writer) => (async () => {
      const posted = [];
      for (let n = 0; n < each; n++) posted.push(await post(token, n, writer));
      return posted;
    })()));
    const wallMs = performance.now() - wallStart;
    const flat = results.flat();
    const accepted = flat.filter(item => item.status === 201);
    const refused = flat.length - accepted.length;
    const samples = accepted.map(item => item.ms);
    const report = {
      "writes/s": accepted.length === 0 ? 0 : Math.round((accepted.length / (wallMs / 1000)) * 100) / 100,
      p50Ms: samples.length ? Math.round(percentile(samples, 50) * 100) / 100 : null,
      p95Ms: samples.length ? Math.round(percentile(samples, 95) * 100) / 100 : null,
      p99Ms: samples.length ? Math.round(percentile(samples, 99) * 100) / 100 : null,
      rowBytes: rowBytes(store),
      writes: accepted.length,
      writers,
      each,
      seed,
      refused,
      rowBytesBefore: before,
      sideTableMessages: store.sideTableMessages === true,
      deferBodyRelease: store.deferBodyRelease === true
    };
    if (refused) {
      const sample = flat.find(item => item.status !== 201);
      process.stderr.write(`refused status=${sample.status} code=${sample.code ?? ""}\n`);
    }
    return report;
  } finally {
    if (server) {
      server.closeStreams?.();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function integerArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value)) throw new Error(`--${name} expects an integer`);
  return value;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const report = await runWriteBurst({
      writers: integerArg("writers") ?? 4,
      each: integerArg("each") ?? 4,
      seed: integerArg("seed") ?? 0,
      sideTableMessages: process.argv.includes("--side-table"),
      deferBodyRelease: process.argv.includes("--defer-release")
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.writes > 0 && report.refused === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
