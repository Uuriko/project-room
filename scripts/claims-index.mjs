#!/usr/bin/env node
// scripts/claims-index.mjs — read-only claims-board indexer for the swarm
// coordination board (Uuriko/project-room#266).
//
// Fetches #266 comments (REST, numeric ids), parses machine-readable claim
// blocks (```room-claim) and receipt comments, and emits a static JSON index
// plus a compact markdown board. Read-only against GitHub: the only network
// call is `gh api .../issues/266/comments --paginate` (a GET). All output
// goes to local files; nothing is committed or pushed by this script.
//
// Malformed input (prose CLAIM: posts, `lease: 6h` without the lease= prefix,
// path-only comments, missing bodies) is recorded under `unregistered` —
// never silently dropped, never a crash.
//
// Usage:
//   node scripts/claims-index.mjs [--comments <file>] [--out <dir>]
//                                 [--format json|md|both] [--now <iso>]
//
//   --comments <file>  read a comments JSON array from disk instead of GitHub
//   --out <dir>        output directory (default: ./claims-index-out)
//   --format           which outputs to write (default: both)
//   --now <iso>        override "now" for lease-expiry computation (tests)

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "Uuriko/project-room";
const ISSUE = 266;
const TASK_ID_RE = /^RC-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]+$/;
const LEASE_RE = /^lease=([0-9]+)h$/;
const STATE_RE = /^(submitted|working|cancelled|suspended|completed|failed\([A-Za-z0-9_]+\))$/;
const STATE_WORD_RE = /^[a-z]+/;
const LIVE_STATES = new Set(["submitted", "working", "suspended"]);
const LEGAL = {
  submitted: ["working", "cancelled"],
  working: ["completed", "failed", "suspended", "cancelled"],
  suspended: ["working", "cancelled"],
};

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const commentsFile = opt("--comments");
const outDir = opt("--out", "./claims-index-out");
const format = opt("--format", "both");
const nowIso = opt("--now") || new Date().toISOString();
if (!["json", "md", "both"].includes(format)) {
  console.error(`claims-index: --format must be json|md|both, got ${format}`);
  process.exit(2);
}
const NOW = Date.parse(nowIso);
if (Number.isNaN(NOW)) {
  console.error(`claims-index: --now is not a valid ISO date: ${nowIso}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

function fetchComments() {
  if (commentsFile) {
    return JSON.parse(readFileSync(commentsFile, "utf8"));
  }
  let out;
  try {
    out = execFileSync(
      "gh",
      ["api", `repos/${REPO}/issues/${ISSUE}/comments`, "--paginate"],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (err) {
    console.error(
      "claims-index: failed to fetch #266 comments via `gh api`. " +
        "Is gh installed and authenticated? (Or pass --comments <file>.)\n" +
        String(err.message).split("\n")[0],
    );
    process.exit(3);
  }
  return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// parse helpers (mirror scripts/room's parse_events semantics)
// ---------------------------------------------------------------------------

const trim = (s) => s.replace(/^[ \t]+|[ \t]+$/, "");

function fence(body, type) {
  const m = body.match(
    new RegExp("```room-" + type + "[ \\t]*\\n([\\s\\S]*?)\\n```"),
  );
  return m ? m[1] : null;
}

function fieldsOf(fenced) {
  const out = {};
  for (const line of fenced.split("\n")) {
    const m = line.match(/^[ \t]*([A-Za-z0-9_-]+)[ \t]*:[ \t]*([\s\S]*)$/);
    if (m) out[m[1]] = trim(m[2]);
  }
  return out;
}

const firstRc = (s) => (s.match(/RC-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]+/) || [])[0] || null;
const firstTask = (s) => (s.match(/[A-Z]+[0-9]*-[0-9]+/) || [])[0] || null;
const firstPr = (s) => {
  const m =
    s.match(/(?:PR|pull)[ \t#:/]*#?([0-9]+)/) || s.match(/project-room#([0-9]+)/);
  return m ? m[1] : null;
};
const firstSha = (s) => {
  const m = s.match(
    /(?<![A-Za-z0-9])[Mm]erge(?:d)?(?: SHA| commit)?[ \t]*:[ \t]*([0-9a-f]{7,40})(?![A-Za-z0-9])/,
  );
  return m ? m[1] : null;
};

// Classify one comment into an event. Never throws for malformed input;
// unrecognized-but-lane-prefixed comments become {kind:"prose"}.
function parseComment(c) {
  const id = c.id;
  const at = c.created_at || null;
  const url = c.html_url || `https://github.com/${REPO}/issues/${ISSUE}#issuecomment-${id}`;
  const rawBody = c.body;
  if (typeof rawBody !== "string") {
    return { id, at, url, lane: null, kind: "unregistered",
             reason: "comment body missing or not a string — not registered" };
  }
  const body = rawBody.replace(/\r/g, "");
  const first = body.split("\n")[0];
  const lp = first.match(/^\[([A-Za-z0-9_-]+)\]([\s\S]*)$/);
  const lane = lp ? lp[1] : null;
  const rest = lp ? trim(lp[2]) : first;
  const pf = rest.match(/^(\[claim\]|\[receipt\]|STATUS:|DONE:|HANDOFF:|RECLAIM)([\s\S]*)$/);
  const prefix = pf ? pf[1] : null;
  const tail = pf ? pf[2] : rest;
  const fclaim = fence(body, "claim");
  const frcpt = fence(body, "receipt");

  if (prefix === "[claim]") {
    if (fclaim) return { id, at, url, lane, kind: "claim", block: fieldsOf(fclaim) };
    // prose [lane][claim] without a fenced block: visible, never a lease
    const taskHint = firstRc(body) || firstTask(body);
    return {
      id, at, url, lane, kind: "unregistered",
      reason: "prose [lane][claim] without a fenced room-claim block — not registered",
      task_hint: taskHint,
    };
  }
  if (prefix === "[receipt]") {
    return {
      id, at, url, lane, kind: "receipt",
      task: firstRc(tail) || firstRc(body) || firstTask(tail) || firstTask(body),
      pr: firstPr(body), merged: firstSha(body),
      receipt: frcpt ? fieldsOf(frcpt) : null,
    };
  }
  if (prefix === "STATUS:") {
    if (fclaim) {
      const heartbeat = /^\s*heartbeat\b/i.test(tail);
      return { id, at, url, lane, kind: "status", block: fieldsOf(fclaim), heartbeat };
    }
    return { id, at, url, lane, kind: "unregistered", reason: "STATUS: without a fenced room-claim block — not registered" };
  }
  if (prefix === "DONE:") {
    return {
      id, at, url, lane, kind: "done",
      task: firstRc(tail),
      pr: firstPr(body), merged: firstSha(body),
      receipt: frcpt ? fieldsOf(frcpt) : null,
    };
  }
  if (prefix === "RECLAIM") {
    const strikeOne = body.match(/<!--\s*room:strike-one:(RC-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]+):([^> \t]+)\s*-->/);
    const strikeTwo = body.match(/<!--\s*room:strike-two:(RC-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]+):([^> \t]+)\s*-->/);
    return {
      id, at, url, lane, kind: "reclaim",
      strike_one: strikeOne ? { task: strikeOne[1], at: strikeOne[2] } : null,
      strike_two: strikeTwo ? { task: strikeTwo[1], at: strikeTwo[2] } : null,
    };
  }
  if (prefix === "HANDOFF:") {
    return { id, at, url, lane, kind: "handoff" }; // tracked for completeness; no board mutation
  }
  // Known malformed shapes, kept visible:
  if (/^\[?[A-Za-z0-9_-]*\]?\s*CLAIM:/i.test(first)) {
    return {
      id, at, url, lane, kind: "unregistered",
      reason: "prose CLAIM: header without the [lane][claim] prefix and fenced block — not registered",
      task_hint: firstRc(body) || firstTask(body),
    };
  }
  return { id, at, url, lane, kind: "prose" };
}

function validateClaim(block) {
  const errs = [];
  const tid = block["task-id"] || "";
  if (!tid) errs.push("missing task-id");
  else if (!TASK_ID_RE.test(tid)) errs.push("task-id not RC-YYYY-MM-DD-NNN");
  if (!block.lane) errs.push("missing lane");
  if (!block.files) errs.push("missing files");
  else if (block.files.includes("*")) errs.push("files: * forbidden");
  const lease = block.lease || "";
  if (!lease) errs.push("missing lease");
  else {
    const m = lease.match(LEASE_RE);
    if (!m) {
      const bare = lease.match(/^([0-9]+)h$/);
      errs.push(bare
        ? `lease must be lease=<N>h (1-72h); did you mean lease=${bare[1]}h?`
        : "lease must be lease=<N>h (1-72h)");
    } else if (+m[1] < 1 || +m[1] > 72) errs.push("lease out of range 1-72h");
  }
  const state = block.state || "";
  if (!state) errs.push("missing state");
  else if (!STATE_RE.test(state)) errs.push("unknown state word: " + state);
  else if (state === "failed") errs.push("failed requires a failure code");
  if (!block.reason) errs.push("missing reason");
  return errs;
}

// ---------------------------------------------------------------------------
// reduce events -> board state
// ---------------------------------------------------------------------------

function reduce(events) {
  const claims = new Map(); // task_id -> claim
  const unregistered = [];
  const refused = [];
  const orphanReceipts = [];
  const parseErrors = [];
  const order = [];

  const expiresAt = (t) => {
    const base = t.heartbeat_at || t.claim_at;
    return base && t.lease_h ? Date.parse(base) + t.lease_h * 3600_000 : null;
  };

  for (const e of events) {
    try {
      switch (e.kind) {
        case "claim": {
          const errs = validateClaim(e.block);
          const tid = e.block["task-id"] || null;
          if (errs.length) {
            unregistered.push({
              comment_id: e.id, at: e.at, url: e.url, lane: e.lane,
              kind: "invalid-claim-block", task_hint: tid, errors: errs,
              reason: "fenced room-claim block failed validation — not registered",
            });
          } else if (claims.has(tid)) {
            const holder = claims.get(tid);
            refused.push({
              comment_id: e.id, at: e.at, url: e.url, task_id: tid,
              by_lane: e.lane, holder_lane: holder.lane || "(released)",
              holder_state: holder.state,
              reason: "duplicate claim refused; task-id already used",
            });
          } else {
            const leaseH = +e.block.lease.match(LEASE_RE)[1];
            claims.set(tid, {
              task_id: tid, lane: e.block.lane,
              files: e.block.files.split(",").map(trim).filter(Boolean),
              lease: e.block.lease, lease_h: leaseH,
              state: e.block.state, reason: e.block.reason,
              claim_at: e.at, claim_comment_id: e.id,
              claim_url: e.url, heartbeat_at: null, last_at: e.at,
              receipts: [], strike_one_at: null, released_at: null,
            });
            order.push(tid);
          }
          break;
        }
        case "unregistered":
          unregistered.push({
            comment_id: e.id, at: e.at, url: e.url, lane: e.lane,
            kind: "malformed", task_hint: e.task_hint || null,
            errors: [], reason: e.reason,
          });
          break;
        case "status": {
          const tid = e.block["task-id"];
          const t = tid && claims.get(tid);
          if (!t) break;
          const toWord = (e.block.state || "").match(STATE_WORD_RE)?.[0] || e.block.state;
          const fromWord = (t.state || "").match(STATE_WORD_RE)?.[0] || t.state;
          if (e.heartbeat || toWord === fromWord) {
            // heartbeat: renews the lease from this comment
            t.heartbeat_at = e.at; t.last_at = e.at;
          } else if (LIVE_STATES.has(fromWord) && (LEGAL[fromWord] || []).includes(toWord)) {
            t.state = e.block.state; t.last_at = e.at;
            if (toWord === "working") t.heartbeat_at = e.at;
          } else {
            unregistered.push({
              comment_id: e.id, at: e.at, url: e.url, lane: e.lane,
              kind: "illegal-transition", task_hint: tid, errors: [],
              reason: `illegal state transition ${t.state} -> ${e.block.state} — ignored`,
            });
          }
          break;
        }
        case "done": {
          const t = e.task && claims.get(e.task);
          const rcpt = {
            comment_id: e.id, at: e.at, url: e.url,
            pr: e.pr || null, merged_sha: e.merged || null,
            kind: "done", fields: e.receipt,
          };
          if (t) { t.state = "completed"; t.last_at = e.at; t.receipts.push(rcpt); }
          else orphanReceipts.push({ ...rcpt, task_hint: e.task });
          break;
        }
        case "receipt": {
          const rcpt = {
            comment_id: e.id, at: e.at, url: e.url,
            pr: e.pr || null, merged_sha: e.merged || null,
            kind: "receipt", fields: e.receipt,
          };
          const t = e.task && claims.get(e.task);
          if (t) { t.receipts.push(rcpt); t.last_at = e.at; }
          else orphanReceipts.push({ ...rcpt, task_hint: e.task });
          break;
        }
        case "reclaim": {
          for (const s of [e.strike_one, e.strike_two]) {
            if (!s) continue;
            const t = claims.get(s.task);
            if (!t) continue;
            if (s === e.strike_one) t.strike_one_at = e.at;
            else { t.state = "submitted"; t.lane = null; t.released_at = e.at; t.strike_one_at = null; t.last_at = e.at; }
          }
          break;
        }
        default:
          break; // prose, handoff, empty: no board mutation
      }
    } catch (err) {
      parseErrors.push({ comment_id: e.id, error: String(err && err.message || err) });
    }
  }

  const list = order.map((tid) => {
    const t = claims.get(tid);
    const exp = expiresAt(t);
    let status;
    if (t.receipts.length > 0) status = "receipted";
    else if (t.released_at) status = "released";
    else if (t.state === "cancelled") status = "cancelled";
    else if (t.state === "completed") status = "completed";
    else if (exp && NOW >= exp) status = "expired";
    else status = "active";
    return { ...t, expires_at: exp ? new Date(exp).toISOString() : null, status };
  });

  return { claims: list, unregistered, refused, orphanReceipts, parseErrors };
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

function emitJson(board, meta) {
  const stats = { total: board.claims.length, active: 0, expired: 0, receipted: 0, completed: 0, cancelled: 0, released: 0 };
  for (const c of board.claims) stats[c.status] = (stats[c.status] || 0) + 1;
  return JSON.stringify({
    generated_at: new Date().toISOString(),
    repo: REPO, issue: ISSUE, now: new Date(NOW).toISOString(),
    comment_count: meta.count, watermark: meta.watermark,
    claims: board.claims,
    unregistered: board.unregistered,
    refused: board.refused,
    orphan_receipts: board.orphanReceipts,
    parse_errors: board.parseErrors,
    stats: { ...stats, unregistered: board.unregistered.length, refused: board.refused.length, orphan_receipts: board.orphanReceipts.length, parse_errors: board.parseErrors.length },
  }, null, 2) + "\n";
}

function mdTable(rows) {
  const head = "| task-id | lane | state | status | expires (UTC) | receipts | claim |";
  const sep = "|---|---|---|---|---|---|---|";
  const esc = (s) => String(s ?? "—").replace(/\|/g, "\\|");
  return [head, sep, ...rows.map((c) =>
    `| ${esc(c.task_id)} | ${esc(c.lane || "(released)")} | ${esc(c.state)} | ${esc(c.status)} | ` +
    `${esc(c.expires_at ? c.expires_at.replace("T", " ").replace("Z", "") : "—")} | ` +
    `${c.receipts.length} | [#${c.claim_comment_id}](${c.claim_url}) |`,
  )].join("\n");
}

function emitMd(board, meta) {
  const L = [];
  L.push(`# Claims board — ${REPO}#${ISSUE}`);
  L.push(``);
  L.push(`_Generated ${new Date().toISOString()} · ${meta.count} comments scanned · watermark ${meta.watermark}_`);
  L.push(``);
  const by = (s) => board.claims.filter((c) => c.status === s);
  const sec = (title, rows) => {
    L.push(`## ${title} (${rows.length})`);
    L.push(``);
    L.push(rows.length ? mdTable(rows) : `_none_`);
    L.push(``);
  };
  sec("Active", by("active"));
  sec("Expired (no receipt)", by("expired"));
  sec("Receipted", by("receipted"));
  sec("Completed / cancelled / released", [...by("completed"), ...by("cancelled"), ...by("released")]);
  L.push(`## Unregistered attempts (${board.unregistered.length})`);
  L.push(``);
  L.push(`Malformed or prose-only posts the board did not register — kept visible so nothing is silently dropped.`);
  L.push(``);
  if (board.unregistered.length) {
    L.push(`| comment | at (UTC) | lane | task hint | reason |`);
    L.push(`|---|---|---|---|---|`);
    for (const u of board.unregistered) {
      const err = (u.errors && u.errors.length ? " — " + u.errors.join("; ") : "");
      L.push(`| [#${u.comment_id}](${u.url}) | ${(u.at || "—").replace("T", " ").replace("Z", "")} | ${u.lane || "—"} | ${u.task_hint || "—"} | ${(u.reason + err).replace(/\|/g, "\\|")} |`);
    }
    L.push(``);
  } else L.push(`_none_`, ``);
  if (board.refused.length) {
    L.push(`## Refused duplicate claims (${board.refused.length})`);
    L.push(``);
    for (const r of board.refused) {
      L.push(`- ${r.task_id}: [#${r.comment_id}](${r.url}) by ${r.by_lane || "—"} — held by ${r.holder_lane} (${r.holder_state})`);
    }
    L.push(``);
  }
  if (board.orphanReceipts.length) {
    L.push(`## Orphan receipts (${board.orphanReceipts.length})`);
    L.push(``);
    for (const o of board.orphanReceipts) {
      L.push(`- task hint ${o.task_hint || "—"}: [#${o.comment_id}](${o.url})${o.pr ? ` PR #${o.pr}` : ""}${o.merged_sha ? ` merge ${o.merged_sha}` : ""}`);
    }
    L.push(``);
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const comments = fetchComments();
  if (!Array.isArray(comments)) {
    console.error("claims-index: expected a JSON array of comments");
    process.exit(3);
  }
  const sorted = [...comments].sort((a, b) =>
    String(a.created_at || "").localeCompare(String(b.created_at || "")) || (a.id - b.id));
  const parseErrors = [];
  const events = [];
  for (const c of sorted) {
    try {
      events.push(parseComment(c));
    } catch (err) {
      parseErrors.push({ comment_id: c && c.id, error: String(err && err.message || err) });
    }
  }
  const board = reduce(events);
  board.parseErrors.push(...parseErrors);
  const meta = {
    count: comments.length,
    watermark: comments.reduce((m, c) => Math.max(m, c.id || 0), 0),
  };

  mkdirSync(outDir, { recursive: true });
  const written = [];
  if (format === "json" || format === "both") {
    const p = join(outDir, "claims-index.json");
    writeFileSync(p, emitJson(board, meta));
    written.push(p);
  }
  if (format === "md" || format === "both") {
    const p = join(outDir, "CLAIMS-BOARD.md");
    writeFileSync(p, emitMd(board, meta));
    written.push(p);
  }
  const n = (xs) => xs.length;
  console.log(
    `claims-index: ${meta.count} comments (watermark ${meta.watermark}) -> ` +
    `${n(board.claims)} claims, ${n(board.unregistered)} unregistered, ` +
    `${n(board.refused)} refused, ${n(board.orphanReceipts)} orphan receipts, ` +
    `${n(board.parseErrors)} parse errors`,
  );
  for (const p of written) console.log(`claims-index: wrote ${p}`);
}

main();
