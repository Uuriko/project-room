#!/usr/bin/env node
// A runnable demonstration that the Room can carry the fleet's own coordination.
//
// docs/growth/FLEET-COORDINATION-2026-09-16.md argues that AGENT-BOARD.md and
// collision-check.rb are a hand-rolled version of something the Room already does
// properly. Arguing it is cheap. This runs it, against the real store rather than
// the pure event engine, because the cross-item path exclusion lives in
// server/claim-scopes.mjs and only exists on the write path.
//
// It walks the four journeys this repo asks of any milestone:
//   success            three agents hold disjoint scopes at once
//   denied             a fourth claim overlapping a live one is refused, 409
//   recovery           releasing the scope frees it for the agent who was refused
//   stale authority    an expired lease stops protecting anything
//
// This is a demonstration on a temporary database. It is not the live Room, it
// enrolls no real agent, and it proves the mechanism, not adoption.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const command = (type, data) => ({ id: crypto.randomUUID(), type, data });

// The lanes the fleet actually runs, with the paths each one really touches.
export const LANES = Object.freeze([
  { agent: "claude", work: "lane-growth", paths: ["docs/growth/**", "src/growth-metrics.js"] },
  { agent: "codex", work: "lane-server", paths: ["server/**"] },
  { agent: "grok", work: "lane-live", paths: ["cloudflare/**", "scripts/live-audit.mjs"] }
]);

export function runPilot({ storePath = null, startedAt = Date.parse("2026-09-16T08:00:00.000Z") } = {}) {
  const transcript = [];
  const say = (journey, outcome, detail) => transcript.push({ journey, outcome, detail });

  const directory = storePath ? null : mkdtempSync(join(tmpdir(), "fleet-pilot-"));
  const filename = storePath ?? join(directory, "room.sqlite");
  let now = startedAt;
  const store = new RoomStore(filename, { now: () => now });
  store.initialize(initialRoom());

  const keys = { owner: store.issueAccessKey("commons", "owner") };
  for (const { agent } of LANES) {
    store.command(keys.owner, "commons", command(T.MEMBER_ADDED, {
      memberId: agent, displayName: agent, kind: "agent", accountableHumanId: "owner",
      permissions: ["accept_work", "complete_work", "write_external"]
    }));
    keys[agent] = store.issueAccessKey("commons", agent);
  }
  say("setup", "ok", `${LANES.length} agents enrolled, each accountable to the owner`);

  const revision = (id) => store.room("commons").state.workItems[id].revision;
  const send = (agent, type, workItemId, data = {}) =>
    store.command(keys[agent], "commons", command(type, { workItemId, expectedRevision: revision(workItemId), ...data }));
  const scope = (paths, minutes = 60) =>
    ({ repository: "project-room", ref: "main", paths, expiresAt: new Date(now + minutes * 60_000).toISOString() });

  const openLane = ({ agent, work }) => {
    store.command(keys.owner, "commons", command(T.WORK_PROPOSED, {
      workItemId: work, title: `${agent} lane`, definitionOfDone: "Lane held",
      accountableMemberId: agent, mode: "write", independentVerificationRequired: false, ownerDecisionRequired: false
    }));
    send(agent, T.WORK_ACCEPTED, work);
  };

  // 1. Success: disjoint scopes coexist, which is what the board is for.
  for (const lane of LANES) {
    openLane(lane);
    send(lane.agent, T.CLAIM_ACQUIRED, lane.work, scope(lane.paths));
    say("success", "claimed", `${lane.agent} holds ${lane.paths.join(", ")}`);
  }

  // 2. Denied: the thing a markdown table cannot do.
  const contested = "docs/growth/ROADMAP-NOTES-2026-09-16.md"; // inside claude's docs/growth/**
  store.command(keys.owner, "commons", command(T.WORK_PROPOSED, {
    workItemId: "lane-intruder", title: "grok edits a growth doc", definitionOfDone: "Should be refused",
    accountableMemberId: "grok", mode: "write", independentVerificationRequired: false, ownerDecisionRequired: false
  }));
  send("grok", T.WORK_ACCEPTED, "lane-intruder");
  const before = store.snapshot(keys.owner, "commons");
  try {
    send("grok", T.CLAIM_ACQUIRED, "lane-intruder", scope([contested]));
    say("denied", "FAILED", "the overlapping claim was accepted, which defeats the whole proposal");
  } catch (error) {
    const clean = JSON.stringify(store.snapshot(keys.owner, "commons")) === JSON.stringify(before);
    say("denied", error.code === "claim_conflict" ? "refused" : "refused-other",
      `${error.code ?? "?"} ${error.status ?? ""}: ${error.message}`.trim());
    say("denied", clean ? "no-trace" : "LEFT-A-TRACE", "Room state after the refusal");
  }

  // 3. Recovery: releasing frees the scope for whoever was waiting.
  send("claude", T.CLAIM_RELEASED, "lane-growth");
  say("recovery", "released", "claude released docs/growth/**");
  send("grok", T.CLAIM_ACQUIRED, "lane-intruder", scope([contested]));
  say("recovery", "claimed", `grok now holds ${contested}`);

  // 4. Stale authority: a lease that has run out protects nothing.
  now += 2 * 60 * 60 * 1000;
  store.command(keys.owner, "commons", command(T.WORK_PROPOSED, {
    workItemId: "lane-after-expiry", title: "codex takes a lapsed scope", definitionOfDone: "Expiry frees it",
    accountableMemberId: "codex", mode: "write", independentVerificationRequired: false, ownerDecisionRequired: false
  }));
  send("codex", T.WORK_ACCEPTED, "lane-after-expiry");
  try {
    send("codex", T.CLAIM_ACQUIRED, "lane-after-expiry", scope([contested]));
    say("stale-authority", "claimed", "codex took the scope after grok's lease expired");
  } catch (error) {
    say("stale-authority", "FAILED", `an expired lease still blocked a new claim: ${error.code ?? error.message}`);
  }

  const state = store.room("commons").state;
  // A claim's stored status stays "active" until it is released, so expiry has to
  // be checked against the clock as well. Reporting status alone would have shown
  // two holders of the same path here, contradicting the journey above.
  const stillHeld = (claim) => claim?.status === "active" && Date.parse(claim.expiresAt) > now;
  const held = Object.values(state.workItems)
    .filter((item) => stillHeld(item.claim))
    .map((item) => ({ work: item.id, holder: item.claim.holderId, paths: item.claim.paths }));
  const lapsed = Object.values(state.workItems)
    .filter((item) => item.claim?.status === "active" && !stillHeld(item.claim))
    .map((item) => ({ work: item.id, holder: item.claim.holderId, paths: item.claim.paths }));

  store.close();
  return { transcript, filename, held, lapsed, cleanup: () => directory && rmSync(directory, { recursive: true, force: true }) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const keep = process.argv.includes("--keep");
  const explicit = process.argv.find((a) => !a.startsWith("--") && a.endsWith(".sqlite"));
  const result = runPilot({ storePath: explicit ?? null });
  const width = Math.max(...result.transcript.map((row) => row.journey.length));
  for (const row of result.transcript) {
    console.log(`${row.journey.padEnd(width)}  ${row.outcome.padEnd(10)}  ${row.detail}`);
  }
  console.log(`\nScopes still in force: ${result.held.length}`);
  for (const lane of result.held) console.log(`  ${lane.holder} -> ${lane.paths.join(", ")}`);
  if (result.lapsed.length) {
    console.log(`Lapsed, protecting nothing: ${result.lapsed.length}`);
    for (const lane of result.lapsed) console.log(`  ${lane.holder} -> ${lane.paths.join(", ")}`);
  }
  if (keep || explicit) console.log(`\nStore kept at ${result.filename}\n  node scripts/growth-report.mjs --store ${result.filename}`);
  else result.cleanup();
}
