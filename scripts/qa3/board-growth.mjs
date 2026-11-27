#!/usr/bin/env node
// Nightly board-growth budget: 400 done claims plus 300 review notes from
// five review-profile members. List p95, the limit=1 body, and room-event
// headroom stay bounded (SEC-2 with Q3-A: F4 event headroom, F8 list).
// Native-room edition: the 400 done claims stay as an explicitly legacy
// terminal fixture (see the seeding note below), the active item is a
// native work item, and the review notes are native discussion messages
// on it. Do not relax the production retirement guard to revive the
// legacy active-claim fixture — that was this harness's original failure
// (qa3-gates run 43056303231, exit 2 at the active-claim seeding).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../../server/store.mjs";
import { createRoomServer } from "../../server/http.mjs";
import { createWork, claimWork, updateWork } from "../../server/work-claims.mjs";
import { readCurrentHead } from "../../server/current-room-repository.mjs";
import { createQaClient } from "../qa2/lib/client.mjs";
import { createReport } from "./lib/summary.mjs";

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
    // Retained legacy contract fixture, explicitly legacy: the 400 done
    // claims are terminal, so the production retirement guard
    // (server/store.mjs beforeSet) admits them in a current-format room,
    // and the Board list read they populate below remains available
    // there. They are the growth population for the list budget.
    const seededAt = Date.now() - 86_400_000;
    for (let i = 0; i < DONE; i++) {
      let item = createWork({ id: `done-${i}`, title: `done ${i}` }, { now: seededAt, agentId: owner.identityId });
      item = claimWork(item, owner.identityId, { now: seededAt, leaseHours: 1 });
      item = updateWork(item, owner.identityId, { state: "in_progress", now: seededAt });
      item = updateWork(item, owner.identityId, { state: "done", note: "finished", now: seededAt });
      store.workClaims.set(roomId, item);
    }
    // The active item is a NATIVE lifecycle fixture: seeding it as a
    // nonterminal legacy claim tripped legacy_work_retired in a
    // current-format room, so it is proposed, accepted, and started
    // through the command bus instead, with the owner accountable.
    let serial = 0;
    const send = (type, data) => store.command(owner.secret, roomId, { id: `qa3-growth-${stamp}-${serial++}`, type, data });
    send("work.proposed", { workItemId: "active-review", title: "review me", definitionOfDone: "reviewed", accountableMemberId: owner.identityId, mode: "read" });
    send("work.accepted", { workItemId: "active-review", expectedRevision: 0 });
    send("work.started", { workItemId: "active-review", expectedRevision: 1 });

    // store.room() refuses current-format rooms; the head read is the
    // native way to observe the room sequence.
    const before = readCurrentHead(store.db, roomId).sequence;
    // Review notes come from review-profile members (SEC-2).
    const guests = [];
    for (let i = 0; i < GUESTS; i++) {
      const name = `Qa3G${i}${stamp}`;
      const guest = must(await client.request("POST", "/api/agent-identities", { body: { displayName: name } }), `mint reviewer ${i}`);
      const invite = must(await client.request("POST", `${roomPath}/agent-invites`, {
        token: owner.secret,
        body: { profile: "review", displayName: name },
      }), `invite reviewer ${i}`);
      must(await client.request("POST", "/api/agent-invites/redeem", {
        token: guest.secret,
        body: { code: invite.code, displayName: name },
      }), `redeem reviewer ${i}`);
      guests.push(guest.secret);
    }
    const perGuest = NOTES / GUESTS;
    // Review notes are native discussion messages on the active item:
    // the legacy /work-claims/:id/review door has no claim to attach to
    // in a native room. Each note is exactly one room event (below).
    await Promise.all(guests.map(async (token, guestIndex) => {
      for (let i = 0; i < perGuest; i++) {
        const response = await client.request("POST", `${roomPath}/commands`, {
          token,
          body: {
            id: randomUUID(), type: "message.posted",
            data: { messageId: randomUUID(), body: `growth ${guestIndex}-${i}`, workItemId: "active-review" },
          },
        });
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`review ${guestIndex}-${i}: HTTP ${response.status} ${response.text.slice(0, 160)}`);
        }
      }
    }));
    const after = readCurrentHead(store.db, roomId).sequence;
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
      // Legacy review notes rode inside claim history and spent no room
      // events, so the old bound was headroom alone. A native discussion
      // note is one room event, so the budget is one event per note plus
      // the same headroom (guest joins land between the two reads): the
      // bound still fails on any event amplification per note.
      { name: "event headroom", ok: after - before <= NOTES + SEQUENCE_HEADROOM, detail: `sequence +${after - before} for ${NOTES} notes` },
    ];
    for (const check of checks) {
      if (check.ok) report.pass(`${check.name} ${check.detail}`);
      else report.fail(`${check.name}`, check.detail);
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
