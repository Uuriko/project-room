#!/usr/bin/env node
// SSE contract: 40 messages keep strict order, no duplicates, and a
// Last-Event-ID resume loses nothing. The per-credential cap of 3 is
// required. The per-room cap is Q3-F and stays skipped.
// Usage: node scripts/qa3/sse-contract.mjs --origin http://127.0.0.1:4173
import { argv, exit } from "node:process";
import { randomUUID } from "node:crypto";
import { createQaClient } from "../qa2/lib/client.mjs";
import { assertLocalOrigin, createReport } from "./lib/summary.mjs";
import { collectSse } from "./lib/sse.mjs";
import { sequenceOf } from "./lib/sequence.mjs";

const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index > 0 ? argv[index + 1] : fallback;
};
const origin = arg("origin", "http://127.0.0.1:4173");
assertLocalOrigin(origin);

const client = createQaClient({ origin, userAgent: "project-room-qa3-sse/1" });
const report = createReport("qa3 sse-contract");
const stamp = Date.now().toString(36);
const cmd = (type, data) => ({ id: randomUUID(), type, data });
const COUNT = 40;

const must = (response, what) => {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${what}: HTTP ${response.status} ${response.json?.error?.code ?? ""} ${response.text.slice(0, 200)}`);
  }
  return response.json;
};

async function openStream(roomPath, token, headers = {}) {
  const abort = new AbortController();
  const response = await fetch(`${origin}${roomPath}/stream`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "text/event-stream",
      "user-agent": "project-room-qa3-sse/1",
      ...headers,
    },
    signal: abort.signal,
  });
  return { abort, response };
}

async function journal(roomPath, token) {
  const events = [];
  let after = 0;
  for (;;) {
    const page = must(await client.request("GET", `${roomPath}/events?limit=100&after=${after}`, { token }), "events");
    events.push(...(page.events ?? []));
    if (!page.hasMore) return events;
    after = page.next;
  }
}

try {
  const owner = must(await client.request("POST", "/api/agent-identities", { body: { displayName: `Qa3Sse${stamp}` } }), "mint");
  const roomId = must(await client.request("POST", "/api/agent-rooms", {
    token: owner.secret,
    body: { title: `qa3-sse-${stamp}`, purpose: "QA3 SSE contract throwaway room" },
  }), "create room").roomId;
  const roomPath = `/api/rooms/${encodeURIComponent(roomId)}`;

  // TODO Q3-F: a per-room SSE cap is not implemented. The credential cap below is the contract that already holds.
  report.skip("per-room stream cap", "TODO Q3-F: per-room SSE cap is not implemented");

  const held = [];
  for (let i = 0; i < 3; i++) {
    const opened = await openStream(roomPath, owner.secret);
    if (opened.response.status !== 200) throw new Error(`stream ${i + 1}: HTTP ${opened.response.status}`);
    held.push(opened);
  }
  const fourth = await fetch(`${origin}${roomPath}/stream`, {
    headers: { authorization: `Bearer ${owner.secret}`, accept: "text/event-stream", "user-agent": "project-room-qa3-sse/1" },
  });
  await fourth.arrayBuffer();
  report.cell({
    name: "per-credential stream cap of 3",
    matched: fourth.status === 429,
    expectedFail: null,
    detail: `4th stream HTTP ${fourth.status}`,
  });
  for (const opened of held) opened.abort.abort();
  await new Promise(resolve => setTimeout(resolve, 300));

  const live = await openStream(roomPath, owner.secret);
  if (live.response.status !== 200) throw new Error(`live stream: HTTP ${live.response.status}`);
  const bodies = Array.from({ length: COUNT }, (_, index) => `sse-${stamp}-${index}`);
  const framesPromise = collectSse(live.response, {
    timeoutMs: 45_000,
    until: frames => bodies.every(body => frames.some(frame => frame.text.includes(body))),
  });
  for (const body of bodies) {
    const posted = await client.request("POST", `${roomPath}/commands`, {
      token: owner.secret,
      body: cmd("message.posted", { messageId: randomUUID(), body }),
    });
    if (posted.status < 200 || posted.status >= 300) {
      throw new Error(`post ${body}: HTTP ${posted.status} ${posted.text.slice(0, 160)}`);
    }
  }
  const frames = await framesPromise;
  live.abort.abort();
  const sequences = frames.map(sequenceOf).filter(value => value !== null);
  const unique = new Set(sequences);
  const ordered = sequences.every((value, index) => index === 0 || value > sequences[index - 1]);
  const sawBodies = bodies.every(body => frames.some(frame => frame.text.includes(body)));
  const log = await journal(roomPath, owner.secret);
  const loggedIds = new Set(log.map(item => item.sequence));
  const lossless = sequences.every(value => loggedIds.has(value)) && bodies.every(body => log.some(item => JSON.stringify(item).includes(body)));
  report.cell({
    name: "ordering, no duplicates, lossless live frames",
    matched: ordered && unique.size === sequences.length && sawBodies && lossless && sequences.length > 0,
    expectedFail: null,
    detail: `frames ${sequences.length}; unique ${unique.size}; ordered ${ordered}; bodies ${sawBodies}; journal ${lossless}`,
  });

  const midpoint = sequences[Math.floor(sequences.length / 2)];
  if (!Number.isInteger(midpoint)) throw new Error("no midpoint sequence to resume from");
  const resume = await openStream(roomPath, owner.secret, { "last-event-id": String(midpoint) });
  if (resume.response.status !== 200) throw new Error(`resume stream: HTTP ${resume.response.status}`);
  const tail = log.filter(item => item.sequence > midpoint);
  const resumed = await collectSse(resume.response, {
    timeoutMs: 8_000,
    until: frames => tail.every(item => frames.some(frame => sequenceOf(frame) === item.sequence)),
  });
  resume.abort.abort();
  const resumedIds = resumed.map(sequenceOf).filter(value => value !== null);
  const resumedUnique = new Set(resumedIds);
  const missing = tail.filter(item => !resumedUnique.has(item.sequence));
  const extra = resumedIds.filter(value => value <= midpoint);
  report.cell({
    name: "Last-Event-ID resume",
    matched: missing.length === 0 && extra.length === 0 && resumedUnique.size === resumedIds.length,
    expectedFail: null,
    detail: `after ${midpoint}; missing ${missing.length}; replayed ${extra.length}; duplicates ${resumedIds.length - resumedUnique.size}`,
  });

  exit(report.finish());
} catch (error) {
  console.error(error.stack || error.message);
  exit(2);
}
