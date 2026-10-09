#!/usr/bin/env node
// scripts/handoff-lint.mjs — GUILD-04 messaging-failure repair lint.
//
// Lints a JSON event sequence for the observed coordination failures,
// using the repair-layer rules in server/agent-handoffs.mjs. Input is a JSON
// array of raw comment/event objects; see tests/fixtures/guild04/ for shape.
// Read-only: never touches the network, never posts.
//
// Usage:
//   node scripts/handoff-lint.mjs < events.json            # exit 0 clean, 2 violations
//   node scripts/handoff-lint.mjs --summary < events.json  # bounded rollup instead
//   node --test tests/guild04-messaging-repairs.test.mjs   # full check
//
// This script lives in scripts/ but is ADDITIVE: it is not wired into any
// npm script, CI job, or server route.

import { readFileSync } from "node:fs";
import {
  normalizeEvent, dedupeKey, ownerMatches, checkThreadParent,
  correlate, summarize,
} from "../server/agent-handoffs.mjs";

function loadEvents() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  let raw;
  if (args.length > 0) {
    raw = readFileSync(args[0], "utf8");
  } else {
    raw = readFileSync(0, "utf8"); // stdin
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function main() {
  const summaryOnly = process.argv.includes("--summary");
  let raw;
  try {
    raw = loadEvents();
  } catch (e) {
    console.error(`handoff-lint: input error: ${e.message}`);
    process.exit(3);
  }

  // Assign log order (array order = log order) so correlate() can sequence.
  const events = raw
    .map((c, i) => {
      const ev = normalizeEvent(c);
      if (ev) ev.seq = i;
      return ev;
    })
    .filter(Boolean);

  const { records, violations } = correlate(events);

  if (summaryOnly) {
    console.log(summarize({ records, violations }, { maxLines: 10 }));
  } else {
    console.log(JSON.stringify({
      events: events.length,
      tasks: records.size,
      violations: violations.map((v) => ({ task_id: v.task_id, code: v.code, detail: v.detail })),
    }, null, 2));
  }

  // Also surface the lint's own cross-checks as JSON diagnostics on stderr
  // for humans: dedupe-key collisions and thread-parent sanity for events
  // that carry explicit parentage (Colony-style threads).
  const diagnostics = [];
  const seen = new Map();
  for (const ev of events) {
    const k = dedupeKey(ev);
    if (k && (ev.kind === "receipt" || ev.kind === "done")) {
      if (seen.has(k)) {
        diagnostics.push({ code: "LINT_DUPLICATE_RECEIPT", key: k, ids: [seen.get(k), ev.id] });
      } else seen.set(k, ev.id);
    }
    if (ev.parent_id && ev.thread_inbound_id) {
      const t = checkThreadParent(ev, ev.thread_inbound_id);
      if (!t.ok) diagnostics.push({ code: "LINT_THREAD_PARENT", id: ev.id, ...t });
    }
    // Ownership probes must resolve by username (author-id trap guard).
    if (ev.probe_owner) {
      const byName = ownerMatches(ev, ev.probe_owner);
      const bySub = ev.jwt_sub === ev.probe_sub;
      diagnostics.push({ code: "LINT_OWNER_PROBE", id: ev.id, username_match: byName, jwt_sub_match: bySub });
    }
  }
  if (diagnostics.length) console.error(JSON.stringify({ diagnostics }, null, 2));

  process.exit(violations.length > 0 ? 2 : 0);
}

main();
