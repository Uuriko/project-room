#!/usr/bin/env node
// Nightly board-growth budget: 400 done claims plus 300 attestations.
// List p95, the limit=1 body, and room-event headroom stay bounded once
// Q3-A lands. Until then a miss is expectedFail (F4 event headroom, F8 list).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../../server/store.mjs";
import { createRoomServer } from "../../server/http.mjs";
import { createWork, claimWork, updateWork } from "../../server/work-claims.mjs";
import { createQaClient } from "../qa2/lib/client.mjs";
import { createReport } from "./lib/summary.mjs";

const FINDING = "F4 F8 Q3-A";
const DONE = 400;
const NOTES = 300;
const GUESTS = 5;
const LIST_P95_MS = 50;
const LIST_BYTES = 32 * 1024;
const SEQUENCE_HEADROOM = 30;
const report = createReport("qa3 board-growth");

function p95(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

const must = (response, what) => {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${what}: HTTP ${response.status} ${response.json?.error?.code ?? ""} ${response.text.slice(0, 200)}`);
  }
  return response.json;
};

async function shareLink(client, roomPath, token) {
  for (let revision = 0; revision <= 8; revision++) {
    const linkToken = randomBytes(32).toString("base64url").slice(0, 43);
    const response = await client.request("POST", `${roomPath}/share-links`, {
      token,
      body: { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600e3, maxJoins: GUESTS + 2, expectedMemberRevision: revision },
    });
    if (response.status < 300) return linkToken;
    if (response.status !== 409) throw new Error(`share link: HTTP ${response.status} ${response.text.slice(0, 200)}`);
  }
  throw new Error("share link: member revision did not match");
}

try {
  const directory = mkdtempSync(join(tmpdir(), "qa3-growth-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = createQaClient({ origin, userAgent: "project-room-qa3-growth/1" });
  const stamp = Date.now().toString(36);
  try {
    const owner = must(await client.request("POST", "/api/agent-identities", { body: { displayName: `Qa3Grow${stamp}` } }), "mint owner");
    const roomId = must(await client.request("POST", "/api/agent-rooms", {
      token: owner.secret,
      body: { title: `qa3-growth-${stamp}`, purpose: "QA3 board growth throwaway room" },
    }), "create room").roomId;
    const roomPath = `/api/rooms/${encodeURIComponent(roomId)}`;
    const seededAt = Date.now() - 86_400_000;
    for (let i = 0; i < DONE; i++) {
      let item = createWork({ id: `done-${i}`, title: `done ${i}` }, { now: seededAt, agentId: owner.identityId });
      item = claimWork(item, owner.identityId, { now: seededAt, leaseHours: 1 });
      item = updateWork(item, owner.identityId, { state: "in_progress", now: seededAt });
      item = updateWork(item, owner.identityId, { state: "done", note: "finished", now: seededAt });
      store.workClaims.set(roomId, item);
    }
    const activeAt = Date.now();
    let active = createWork({ id: "active-review", title: "review me" }, { now: activeAt, agentId: owner.identityId });
    active = claimWork(active, owner.identityId, { now: activeAt, leaseHours: 24 });
    active = updateWork(active, owner.identityId, { state: "in_progress", now: activeAt });
    store.workClaims.set(roomId, active);

    const before = store.room(roomId).sequence;
    const linkToken = await shareLink(client, roomPath, owner.secret);
    const guests = [];
    for (let i = 0; i < GUESTS; i++) {
      const guest = must(await client.request("POST", "/api/agent-identities", { body: { displayName: `Qa3G${i}${stamp}` } }), `mint guest ${i}`);
      must(await client.request("POST", "/api/share-links/join-agent", {
        token: guest.secret,
        body: { linkToken, displayName: `Qa3G${i}${stamp}` },
      }), `join guest ${i}`);
      guests.push(guest.secret);
    }
    const perGuest = NOTES / GUESTS;
    await Promise.all(guests.map(async (token, guestIndex) => {
      for (let i = 0; i < perGuest; i++) {
        const response = await client.request("POST", `${roomPath}/work-claims/active-review/review`, {
          token,
          body: { note: `growth ${guestIndex}-${i}` },
        });
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`review ${guestIndex}-${i}: HTTP ${response.status} ${response.text.slice(0, 160)}`);
        }
      }
    }));
    const after = store.room(roomId).sequence;
    const samples = [];
    let bytes = 0;
    const warm = await client.request("GET", `${roomPath}/work-claims?limit=1`, { token: owner.secret });
    if (warm.status !== 200) throw new Error(`list warmup HTTP ${warm.status}`);
    for (let i = 0; i < 20; i++) {
      const page = await client.request("GET", `${roomPath}/work-claims?limit=1`, { token: owner.secret });
      if (page.status !== 200) throw new Error(`list HTTP ${page.status}`);
      samples.push(page.ms);
      bytes = Buffer.byteLength(page.text);
    }
    const elapsed = p95(samples);
    const checks = [
      { name: "list p95", ok: elapsed < LIST_P95_MS, detail: `p95 ${elapsed.toFixed(1)} ms` },
      { name: "limit=1 bytes", ok: bytes < LIST_BYTES, detail: `${bytes} bytes` },
      { name: "event headroom", ok: after - before <= SEQUENCE_HEADROOM, detail: `sequence +${after - before}` },
    ];
    const missed = checks.filter(check => !check.ok);
    if (missed.length === 0) {
      report.fail("board growth", `${FINDING} expectedFail is set but every bound held; remove the flag`);
    } else {
      for (const check of checks) {
        if (check.ok) report.pass(`${check.name} ${check.detail}`);
        else report.expectFail(`${check.name} ${check.detail}`, FINDING);
      }
    }
  } finally {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(report.finish());
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(2);
}
