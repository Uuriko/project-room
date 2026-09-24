// Public run-receipts snapshot generator.
//
// Reads the room's receipt board (Uuriko/project-room#266 comments), parses
// every [lane][receipt] / [lane][done] post, and writes
// server/receipts-data.mjs — the generated data module behind the public
// /receipts page and /api/public/receipts endpoint.
//
// Every number in the snapshot comes from a real board comment; nothing is
// fabricated. A receipt is one board post. Result meanings:
//   verified = the receipt's merge SHA (or its PR's merge commit) exists in
//              Uuriko/project-room upstream.
//   failed   = a merge was claimed but no merge commit could be confirmed
//              (no SHA given, or the SHA is not in the repo).
//   open     = the receipt announces an opened PR with no merge claimed yet.
//   reported = the run was reported complete with no merge artifact to check
//              (e.g. read-only scans, triage runs).
//
// Usage: node scripts/receipts-snapshot.mjs [--out server/receipts-data.mjs]
// Requires: gh (authenticated, same credential room-watch uses). No git
// history is needed: SHA verification goes through the GitHub API so the
// snapshot reflects the upstream repo, not whatever the local clone has.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = "Uuriko/project-room";
const ISSUE = 266;
const BOARD_URL = `https://github.com/${REPO}/issues/${ISSUE}`;
const REPO_URL = `https://github.com/${REPO}`;

const outPath = (() => {
  const i = process.argv.indexOf("--out");
  return resolve(ROOT, i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "server/receipts-data.mjs");
})();

const ghJson = (...args) =>
  JSON.parse(execFileSync("gh", ["api", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024, // the full #266 comment history is several MB
  }));

// --jq string projections come back raw (unquoted), not as JSON.
const ghText = (...args) =>
  execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// gh api -> { ok, value }: 422/404 mean "not found", anything else throws.
const ghMaybe = (...args) => {
  try {
    return { ok: true, value: ghJson(...args) };
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (/HTTP 4(04|22)/.test(stderr)) return { ok: false, value: null };
    throw error;
  }
};

const ghMaybeText = (...args) => {
  try {
    return { ok: true, value: ghText(...args) };
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (/HTTP 4(04|22)/.test(stderr)) return { ok: false, value: null };
    throw error;
  }
};

// --- comment -> receipt parsing -------------------------------------------
// Mirrors the room-watch parser's field extractors (scripts/room:
// first_task / first_pr / first_sha) plus the fenced room-receipt/room-done
// blocks. Anything this cannot parse is left out of the snapshot rather
// than guessed at.

const lanePrefix = /^\[([A-Za-z0-9_-]+)\]\[(receipt|done)\]/;
const donePrefix = /^DONE:\s*\[([A-Za-z0-9_-]+)\]\[receipt\]/i;
const bareReceiptPrefix = /^\[([A-Za-z0-9_-]+)\]\s*receipt:/i;

function fencedFields(body, ...names) {
  for (const name of names) {
    const m = new RegExp("```room-" + name + "[ \\t]*\\n([\\s\\S]*?)\\n```").exec(body);
    if (!m) continue;
    const fields = {};
    for (const line of m[1].split("\n")) {
      const kv = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
      if (kv) fields[kv[1]] = kv[2];
    }
    return fields;
  }
  return null;
}

const firstTask = (body) =>
  (/RC-\d{4}-\d{2}-\d{2}-\d+/.exec(body)?.[0] ?? /\b([A-Z]+[0-9]*-\d+)\b/.exec(body)?.[1] ?? null);

const firstPr = (body) => {
  // Explicit PR references only. A bare "project-room#N" is an issue
  // reference, not a PR, so it must not become a /pull/ link.
  const m = /(?:PR|pull)[ \t#:/]*#?(\d+)/i.exec(body) ?? /\/pull\/(\d+)/.exec(body);
  return m ? Number(m[1]) : null;
};

const hexRun = (text) => /\b([0-9a-f]{7,40})\b/.exec(text ?? "")?.[1] ?? null;

function extractSha(body, fields) {
  if (fields) {
    const fromFields = hexRun(fields.merged ?? fields["merge-sha"] ?? fields.merge ?? fields.sha ?? "");
    if (fromFields) return fromFields;
  }
  // "merged 68d944d…", "MERGED at 926ac59…", "merged as 7c2eeb5b",
  // "merged into main: 46e7af2…", "merged: PR #492 → main at 5da84a4e…".
  // The gap is lazy on purpose: a greedy gap can skip into the middle of
  // the SHA and capture its tail.
  const m = /\bmerg(?:e|ed)\b[^\n]{0,40}?([0-9a-f]{7,40})\b/i.exec(body);
  if (m) return m[1];
  // Multi-PR merge lists use arrows: "- #364 B010 … → 3b33eb20…".
  const arrow = /→\s*([0-9a-f]{7,40})\b/.exec(body);
  return arrow ? arrow[1] : null;
}

// Does the receipt claim its own work merged? A claim needs a checkable
// artifact: an extracted SHA, a fenced merged: field that is not "none" /
// empty, or merge language tied to a named PR. Bare "merged" with no PR or
// SHA is too vague to check (reported, not failed), and negated merge
// language ("not merged", "no patch merged") is explicitly not a claim.
function isMergeClaim(body, fields, sha, pr) {
  if (sha) return true;
  if (fields && "merged" in fields) return !/^\s*(none)?\s*$/i.test(fields.merged ?? "");
  if (pr == null) return false;
  if (/\b(?:no|not|never)\s+(?:\w+\s+){0,3}merg(?:e|ed|ing)\b/i.test(body)) return false;
  return /\bmerg(?:e|ed|ing)\b/i.test(body);
}

function isOpenPr(body) {
  return /\b(?:reopen(?:ed)?|open(?:ed)?)\b[^.\n]{0,16}?\bPR\b|\bPR\s*#?\d+\b[^.\n]{0,16}?\bopen(?:ed)?\b/i.test(body);
}

// Truncate a board excerpt for the snapshot. A trailing ellipsis marks a cut.
// The runtime-package gate scans .mjs files for `from "` / `import "` import
// patterns, so a value must never end on those words right before the JSON
// closing quote (false positive, not a real import).
function truncateSummary(body, max = 160) {
  let s = body.replace(/\s+/g, " ").trim();
  let cut = false;
  if (s.length > max) { s = s.slice(0, max).trimEnd(); cut = true; }
  if (/\b(from|import)$/i.test(s)) return s + " …";
  return cut ? s + "…" : s;
}

function parseReceipt(comment) {
  const body = comment.body ?? "";
  const firstLine = body.split("\n")[0];
  const laneMatch = lanePrefix.exec(firstLine) ?? donePrefix.exec(firstLine) ?? bareReceiptPrefix.exec(firstLine);
  if (!laneMatch) return null;
  const lane = laneMatch[1].toLowerCase();
  const fields = fencedFields(body, "receipt", "done");
  const task = fields?.["task-id"] ?? fields?.claim ?? firstTask(body);
  const pr = (() => {
    const fromFields = fields?.pr ? Number(/(\d+)/.exec(fields.pr)?.[1] ?? NaN) : NaN;
    return Number.isFinite(fromFields) ? fromFields : firstPr(body);
  })();
  const sha = extractSha(body, fields);
  const mergedClaim = isMergeClaim(body, fields, sha, pr);
  const openedOnly = !mergedClaim && isOpenPr(body);
  const summary = truncateSummary(body);
  return {
    task: task ?? null,
    lane,
    date: String(comment.created_at).slice(0, 10),
    pr: pr ?? null,
    prUrl: pr != null ? `${REPO_URL}/pull/${pr}` : null,
    sha,
    commentId: comment.id,
    commentUrl: `${BOARD_URL}#issuecomment-${comment.id}`,
    summary,
    mergedClaim,
    openedOnly,
  };
}

// --- main ------------------------------------------------------------------

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const failures = [];
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        failures.push(`${items[i]}: ${String(error.stderr ?? error.message).split("\n")[0]}`);
        results[i] = undefined;
      }
    }
  });
  await Promise.all(workers);
  for (const failure of failures) console.error(`receipts-snapshot: lookup failed, treating as unverified: ${failure}`);
  return results;
}

async function main() {
  let comments;
  try {
    comments = ghJson(`repos/${REPO}/issues/${ISSUE}/comments?per_page=100`, "--paginate");
  } catch (error) {
    console.error(`receipts-snapshot: cannot read board comments (gh auth?): ${String(error.stderr ?? error.message).split("\n")[0]}`);
    process.exit(1);
  }
  if (!Array.isArray(comments)) throw new Error("receipts-snapshot: unexpected comments payload");

  const parsed = [];
  for (const comment of comments) {
    const receipt = parseReceipt(comment);
    if (receipt) parsed.push(receipt);
  }
  parsed.sort((a, b) => a.commentId - b.commentId);

  // One row per run: duplicate receipt posts for the same task+merge keep
  // the earliest post so a repost does not double-count the run.
  const seen = new Set();
  const receipts = parsed.filter((r) => {
    if (r.task && r.sha) {
      const key = `${r.task}\u0000${r.sha}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  });

  // PR merge commits for receipts that claim a merge but name no SHA, and
  // for opened-PR receipts (a PR announced as opened may have merged
  // since; if its merge commit exists the work verifiably landed).
  const prsNeeded = [...new Set(receipts.filter((r) => (r.mergedClaim || r.openedOnly) && !r.sha && r.pr != null).map((r) => r.pr))];
  const prMerges = new Map();
  await pool(prsNeeded, 8, async (pr) => {
    const res = ghMaybe(`repos/${REPO}/pulls/${pr}`);
    if (res.ok && res.value?.merged) prMerges.set(pr, res.value.merge_commit_sha);
  });
  // Verify every candidate SHA against the upstream repo.
  const candidates = new Map(); // sha -> Set of receipt indexes
  receipts.forEach((r, i) => {
    const shas = new Set();
    if (r.sha) shas.add(r.sha);
    const prSha = r.pr != null ? prMerges.get(r.pr) : undefined;
    if (prSha) shas.add(prSha);
    for (const sha of shas) {
      if (!candidates.has(sha)) candidates.set(sha, new Set());
      candidates.get(sha).add(i);
    }
  });
  const verifiedSha = new Map(); // sha -> full sha
  await pool([...candidates.keys()], 8, async (sha) => {
    const res = ghMaybeText(`repos/${REPO}/commits/${sha}`, "--jq", ".sha");
    if (res.ok && typeof res.value === "string" && /^[0-9a-f]{40}$/.test(res.value)) verifiedSha.set(sha, res.value);
  });

  const upstreamMain = ghText(`repos/${REPO}/commits/main`, "--jq", ".sha");

  const rows = receipts.map((r) => {
    const shas = [r.sha, r.pr != null ? prMerges.get(r.pr) : undefined].filter(Boolean);
    const full = shas.map((s) => verifiedSha.get(s)).find(Boolean) ?? null;
    let result;
    if (full) result = "verified";
    else if (r.openedOnly) result = "open";
    else if (!r.mergedClaim) result = "reported";
    else result = "failed";
    return {
      task: r.task,
      lane: r.lane,
      date: r.date,
      pr: r.pr,
      prUrl: r.prUrl,
      sha: r.sha,
      shaFull: full,
      shaUrl: full ? `${REPO_URL}/commit/${full}` : r.sha ? `${REPO_URL}/commit/${r.sha}` : null,
      result,
      commentId: r.commentId,
      commentUrl: r.commentUrl,
      summary: r.summary,
    };
  });

  const snapshot = {
    generatedAt: new Date().toISOString(),
    board: `${REPO}#${ISSUE}`,
    boardUrl: BOARD_URL,
    repoUrl: REPO_URL,
    upstreamMain,
    commentsScanned: comments.length,
    receipts: rows,
  };

  const header = `// GENERATED by scripts/receipts-snapshot.mjs — do not hand-edit.
// Source: ${REPO}#${ISSUE} comments (${comments.length} scanned). Regenerate:
//   node scripts/receipts-snapshot.mjs
// Every number below was parsed from a real board post; nothing is
// fabricated. Result meanings: verified = the receipt's merge SHA (or its
// PR's merge commit) exists upstream; failed = a merge was claimed but no
// merge commit could be confirmed; open = an opened PR with no merge
// claimed yet; reported = the run was reported complete with no merge
// artifact to check.
`;
  writeFileSync(outPath, header + `export const RECEIPTS_SNAPSHOT = ${JSON.stringify(snapshot, null, 2)};\n`);

  const counts = { verified: 0, failed: 0, open: 0, reported: 0 };
  for (const r of rows) counts[r.result]++;
  console.log(`receipts-snapshot: ${rows.length} receipts (${counts.verified} verified, ${counts.failed} failed, ${counts.open} open, ${counts.reported} reported) from ${comments.length} board comments -> ${outPath}`);
}

await main();
