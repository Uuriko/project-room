#!/usr/bin/env node
//
// scripts/weekly-learnings.mjs
//
// Weekly "learnings" auto-post for muse-room (backlog W007).
//
// Gathers the week's signal and posts ONE concise digest to the room:
//   - merged PRs (via gh), each with a one-line lesson (a `Lesson:` line in
//     the PR body when present, otherwise the PR title),
//   - room DONE posts and BUG CONFIRMED posts (room event log),
//   - curated lessons lanes append to docs/WEEKLY-LEARNINGS.md.
//
// Anti-spam: skips the week when there is nothing material, hard-caps the
// post length, and never posts twice for the same ISO week (idempotency via
// a sent log in the state dir, default ~/.config/weekly-learnings/).
//
// Usage:
//   node scripts/weekly-learnings.mjs [--since ISO] [--week 2026-W41]
//       [--queue PATH] [--repo OWNER/REPO] [--room ROOM]
//       [--state-dir DIR] [--dry-run] [--post]
//
// Default is a dry run (print the digest, post nothing). --post is required
// to actually post. Exit 0 on ok / dry-run / skip; 1 on error.
//
// The pure helpers are exported for tests/weekly-learnings.test.js (repo
// convention: scripts export helpers, tests import them).

import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import https from "node:https";

// ---------------------------------------------------------------------------
// pure helpers (exported, unit-tested)
// ---------------------------------------------------------------------------

const MAX_CHARS = 4000;
const MAX_SHIPPED = 8;
const MAX_BUGS = 6;
const MAX_LEARNED = 10;
const MAX_DONE = 6;
const ONE_LINE_CAP = 160;
const PR_FETCH_LIMIT = 200;
const EVENT_PAGE_LIMIT = 200; // pages of 100 events; hitting it fails closed (see below)

function oneLine(s, cap = ONE_LINE_CAP) {
  const t = String(s ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > cap ? t.slice(0, cap - 1) + "…" : t;
}

/** ISO week id, e.g. "2026-W41". */
export function weekId(d = new Date()) {
  const dt = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  const day = (dt.getUTCDay() + 6) % 7; // Mon=0
  dt.setUTCDate(dt.getUTCDate() - day + 3); // Thursday of this week
  const first = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const fday = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(first.getUTCDate() - fday + 3); // Thursday of week 1
  const week = 1 + Math.round((dt - first) / (7 * 864e5));
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * One-line lesson for a merged PR: the first `Lesson:` line in the body
 * (case-insensitive), falling back to the PR title.
 */
export function lessonFromPr(pr) {
  const body = String(pr.body ?? "");
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*lessons?\s*:\s*(.+?)\s*$/i);
    if (m) return oneLine(m[1]);
  }
  return oneLine(pr.title);
}

/**
 * Split room message events into DONE highlights and BUG CONFIRMED items.
 * events: [{ sequence, body }]. Everything else (PROGRESS, CLAIM, ASK, …)
 * is ignored.
 */
export function extractRoomSignal(events) {
  const done = [];
  const bugs = [];
  for (const e of events) {
    const body = String(e.body ?? "");
    if (/^\s*done\b/i.test(body)) {
      done.push(oneLine(body.replace(/^\s*done\s*:?\s*/i, "")));
    } else if (/^\s*bug\s+confirmed\s*:/i.test(body)) {
      bugs.push(oneLine(body.replace(/^\s*bug\s+confirmed\s*:\s*/i, "")));
    }
  }
  return { done, bugs };
}

/**
 * Parse the curated lessons queue. Returns entries under the current
 * ISO-week heading plus the `## unfiled` section; other weeks are ignored.
 * entries: [{ text, source: "week" | "unfiled" }].
 */
export function parseQueue(markdown, id) {
  const entries = [];
  const lines = String(markdown ?? "").split("\n");
  let section = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const name = h[1].trim().toLowerCase();
      section =
        name === id.toLowerCase() ? "week" : name === "unfiled" ? "unfiled" : null;
      continue;
    }
    if (section) {
      const m = line.match(/^\s*-\s+(.+?)\s*$/);
      if (m) entries.push({ text: m[1], source: section });
    }
  }
  return entries;
}

/** Anti-spam: a week with fewer than 3 total signal items stays silent. */
export function isMaterial({ prs, done, bugs, lessons }) {
  const n =
    (prs?.length ?? 0) +
    (done?.length ?? 0) +
    (bugs?.length ?? 0) +
    (lessons?.length ?? 0);
  return n >= 3;
}

/** Idempotency: has this ISO week already been posted? */
export function weekAlreadySent(sentLog, id) {
  if (!sentLog) return false;
  return String(sentLog)
    .split("\n")
    .some((line) => line.split("\t")[0] === id);
}

/**
 * Watermark commit policy (pure contract; review finding: never advance the
 * cursor past signals that were not consumed).
 *
 * - truncated (hit the page cap with more events pending): preserve the
 *   partial head AND the original window start, so the next run resumes the
 *   walk with the same window instead of permanently skipping the rest.
 * - posted (digest posted successfully): advance to the walk head and start
 *   the next window now.
 * - otherwise (dry run, skip, failed post, already sent): write nothing.
 *   Dry runs are strictly read-only.
 */
export function watermarkDecision({ head, truncated, posted, windowStartMs, nowMs }) {
  if (truncated) {
    return { write: true, after: head, windowStartMs };
  }
  if (posted) {
    return { write: true, after: head, windowStartMs: nowMs };
  }
  return { write: false };
}

/** Read the persisted room cursor, or null on a first run. */
export function readWatermark(stateDir) {
  const wmPath = join(stateDir, "room-watermark.json");
  if (!existsSync(wmPath)) return null;
  try {
    const wm = readJson(wmPath);
    const after = Number(wm.after);
    const windowStartMs = Number(wm.windowStartMs);
    if (!Number.isFinite(after) || !Number.isFinite(windowStartMs)) return null;
    return { after, windowStartMs };
  } catch {
    return null;
  }
}

/** Persist the room cursor. Called only via watermarkDecision. */
export function commitWatermark(stateDir, after, windowStartMs) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "room-watermark.json"),
    JSON.stringify({ after, windowStartMs, at: new Date().toISOString() }) + "\n"
  );
}

function bulletList(items, max, total = items.length) {
  const shown = items.slice(0, max);
  const lines = shown.map((t) => `• ${oneLine(t)}`);
  if (total > max) lines.push(`(…+${total - max} more)`);
  return lines;
}

/**
 * Render the digest. Returns the post text, or null when there is nothing
 * material (the week is skipped).
 */
export function renderDigest({ weekLabel, prs, totalPrs, done, bugs, lessons }) {
  if (!isMaterial({ prs, done, bugs, lessons })) return null;
  const shippedTotal = Number.isFinite(totalPrs) ? totalPrs : prs.length;

  const sections = [];
  sections.push(`🪔 Weekly learnings — ${weekLabel}`);

  const shipped = prs.map((pr) => {
    const title = oneLine(pr.title);
    const lesson = lessonFromPr(pr);
    const suffix = lesson && lesson !== title ? ` — ${lesson}` : "";
    return `#${pr.number} ${title}${suffix}`;
  });
  sections.push(
    [`SHIPPED — ${shippedTotal} merged PR${shippedTotal === 1 ? "" : "s"}`,
     ...bulletList(shipped, MAX_SHIPPED, shippedTotal)].join("\n")
  );

  if (bugs.length) {
    sections.push(["BROKE & FIXED", ...bulletList(bugs, MAX_BUGS)].join("\n"));
  }

  if (lessons.length) {
    sections.push(["LEARNED", ...bulletList(lessons, MAX_LEARNED)].join("\n"));
  }

  if (done.length) {
    sections.push(
      [`DONE THIS WEEK — ${done.length}`, ...bulletList(done, MAX_DONE)].join("\n")
    );
  }

  sections.push("📝 Lanes: append next week's lessons to docs/WEEKLY-LEARNINGS.md");

  let out = sections.join("\n\n");
  const suffix = "… (trimmed for length)";
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS - suffix.length) + suffix;
  return out;
}

// ---------------------------------------------------------------------------
// gathering + posting (impure, runs only as a script)
// ---------------------------------------------------------------------------

const ORIGIN = "https://room.trydemigod.com";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function roomToken() {
  const cfg = join(homedir(), ".config", "jill-room", "conn", "connection.json");
  return readJson(cfg).token;
}

function roomIdentitySecret() {
  const cfg = join(homedir(), ".config", "jill-room", "identity.json");
  return readJson(cfg).secret;
}

function httpsJson({ method = "GET", path, body, token }) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": "weekly-learnings/1.0" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const req = https.request(
      `${ORIGIN}${path}`,
      { method, headers, timeout: 30000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

/** Merged PRs in the repo since `since` (ISO), newest first. */
function fetchMergedPrs(repo, since) {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--repo", repo, "--state", "merged", "--limit", String(PR_FETCH_LIMIT),
     "--json", "number,title,body,mergedAt,author"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  return JSON.parse(out)
    .filter((pr) => pr.mergedAt && pr.mergedAt >= since)
    .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1));
}

/**
 * Honest merged-PR total for the header, via the search API. Returns null
 * when the search call fails (caller falls back to the fetched list length).
 */
function countMergedPrs(repo, sinceDate) {
  const day = sinceDate.toISOString().slice(0, 10);
  const q = encodeURIComponent(
    `repo:${repo} type:pr is:merged merged:>=${day}`
  );
  try {
    const out = execFileSync(
      "gh",
      ["api", `search/issues?q=${q}&per_page=1`, "--jq", ".total_count"],
      { encoding: "utf8" }
    );
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Room message events for the window. Walks the after-cursor, limit=100 per
 * page (the API's cap). Pure read: never touches the watermark — the caller
 * commits it via watermarkDecision() only after a successful post.
 * Returns { events, head, truncated }.
 */
async function fetchRoomEvents(room, sinceMs, startAfter) {
  const token = roomToken();
  let after = Number(startAfter) || 0;
  const events = [];
  let head = after;
  let truncated = false;
  for (let page = 0; page < EVENT_PAGE_LIMIT; page++) {
    const qs = `limit=100${after ? `&after=${after}` : ""}`;
    const data = await httpsJson({
      path: `/api/rooms/${room}/events?${qs}`,
      token,
    });
    const evs = data.events ?? [];
    if (!evs.length) break;
    for (const e of evs) {
      const seq = Number(e.sequence) || 0;
      if (seq > head) head = seq;
      const ev = e.event ?? {};
      if (ev.type !== "message.posted") continue;
      const at = Date.parse(ev.at ?? "");
      if (!Number.isFinite(at) || at < sinceMs) continue;
      const body = ev.data?.body;
      if (body) events.push({ sequence: seq, body: String(body) });
    }
    after = head;
    if (!data.hasMore) break;
    if (page === EVENT_PAGE_LIMIT - 1) truncated = true;
  }
  return { events, head, truncated };
}

/** Post one message to the room as the owner identity. */
async function postToRoom(room, text) {
  const { randomUUID } = await import("node:crypto");
  await httpsJson({
    method: "POST",
    path: `/api/rooms/${room}/commands`,
    token: roomIdentitySecret(),
    body: {
      id: randomUUID(),
      type: "message.posted",
      data: { messageId: randomUUID(), body: text },
    },
  });
}

function parseArgs(argv) {
  const args = {
    since: null,
    week: null,
    queue: null,
    repo: process.env.WEEKLY_LEARNINGS_REPO || "Uuriko/project-room",
    room: process.env.WEEKLY_LEARNINGS_ROOM || "muse-room",
    stateDir:
      process.env.WEEKLY_LEARNINGS_STATE_DIR ||
      join(homedir(), ".config", "weekly-learnings"),
    dryRun: false,
    post: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`missing value for ${a}`);
    if (a === "--since") args.since = next();
    else if (a === "--week") args.week = next();
    else if (a === "--queue") args.queue = next();
    else if (a === "--repo") args.repo = next();
    else if (a === "--room") args.room = next();
    else if (a === "--state-dir") args.stateDir = next();
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--post") args.post = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: node scripts/weekly-learnings.mjs [--since ISO] [--week ID] [--queue PATH]\n" +
          "       [--repo OWNER/REPO] [--room ROOM] [--state-dir DIR] [--dry-run] [--post]\n" +
          "default is a dry run (prints the digest, posts nothing)."
      );
      process.exit(0);
    } else die(`unknown flag ${a}`);
  }
  return args;
}

function die(msg) {
  console.error(`weekly-learnings: error: ${msg}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const sinceDate = args.since ? new Date(args.since) : new Date(now.getTime() - 7 * 864e5);
  if (!Number.isFinite(sinceDate.getTime())) die(`bad --since value`);
  const since = sinceDate.toISOString();
  const id = args.week || weekId(now);
  const weekLabel = `${since.slice(0, 10)} → ${now.toISOString().slice(0, 10)}`;

  mkdirSync(args.stateDir, { recursive: true });
  const sentPath = join(args.stateDir, "sent.log");
  const sentLog = existsSync(sentPath) ? readFileSync(sentPath, "utf8") : "";

  if (weekAlreadySent(sentLog, id)) {
    console.error(`weekly-learnings: skip: week ${id} already posted`);
    return;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(scriptDir);
  const queuePath = args.queue || join(repoRoot, "docs", "WEEKLY-LEARNINGS.md");

  let prs = [];
  try {
    prs = fetchMergedPrs(args.repo, since);
  } catch (e) {
    die(`gh pr list failed: ${e.message}`);
  }

  let events = [];
  let roomHead = 0;
  // The window start persists across runs when a walk truncates, so a moved
  // clock never filters out events a previous run fetched but never posted.
  const storedWm = readWatermark(args.stateDir);
  const windowStartMs = args.since
    ? sinceDate.getTime()
    : storedWm?.windowStartMs ?? sinceDate.getTime();
  try {
    const walk = await fetchRoomEvents(args.room, windowStartMs, storedWm?.after ?? 0);
    events = walk.events;
    roomHead = walk.head;
    if (walk.truncated) {
      // Fail closed: preserve the partial cursor + original window so the
      // next run resumes the walk instead of permanently skipping the rest.
      const d = watermarkDecision({
        head: roomHead,
        truncated: true,
        posted: false,
        windowStartMs,
        nowMs: now.getTime(),
      });
      commitWatermark(args.stateDir, d.after, d.windowStartMs);
      die(
        `room event walk hit the ${EVENT_PAGE_LIMIT}-page cap with more events pending; ` +
          `partial cursor preserved, rerun to continue (raise the cap if this recurs)`
      );
    }
  } catch (e) {
    die(`room events fetch failed: ${e.message}`);
  }
  const { done, bugs } = extractRoomSignal(events);

  let lessons = [];
  if (existsSync(queuePath)) {
    lessons = parseQueue(readFileSync(queuePath, "utf8"), id).map((e) => e.text);
  }

  let totalPrs = prs.length;
  if (prs.length >= PR_FETCH_LIMIT) {
    const n = countMergedPrs(args.repo, sinceDate);
    if (n !== null) totalPrs = n;
  }

  const digest = renderDigest({ weekLabel, prs, totalPrs, done, bugs, lessons });
  if (!digest) {
    console.error("weekly-learnings: skip: nothing material this week");
    return;
  }

  if (!args.post || args.dryRun) {
    console.log(digest);
    if (!args.post)
      console.error("weekly-learnings: dry run (pass --post to post; watermark untouched)");
    return;
  }

  await postToRoom(args.room, digest);
  // Commit the room cursor only after a successful post: a failed post or a
  // dry run must never advance past unconsumed signals.
  const d = watermarkDecision({
    head: roomHead,
    truncated: false,
    posted: true,
    windowStartMs,
    nowMs: now.getTime(),
  });
  if (d.write) commitWatermark(args.stateDir, d.after, d.windowStartMs);
  appendFileSync(sentPath, `${id}\t${now.toISOString()}\t${digest.length} chars\n`);
  console.error(`weekly-learnings: posted ${digest.length} chars for week ${id}`);
}

const isMain =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((e) => die(e.message || String(e)));
}
