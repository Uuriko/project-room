// Decisions the pr-guardrails workflow posts. The workflow itself only
// fetches GitHub JSON and prints these results; nothing here fails a check.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_OPEN_PR_CAP, STALE_QUIET_HOURS, fileSetSimilarity, findDuplicatePulls,
  claimFirstReport, authorCapDecision, planStaleClose, mergeArchivedWork,
} from "../scripts/pr-guardrails.mjs";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts/pr-guardrails.mjs");

function numbered(count, start = 0) {
  return Array.from({ length: count }, (_, index) => `src/f${start + index}.js`);
}

test("file-set Jaccard duplicates at 0.7, on a real subset, and ignores ubiquitous paths", () => {
  const sevenOfTen = fileSetSimilarity(numbered(7), numbered(10));
  assert.equal(sevenOfTen.shared.length, 7);
  assert.equal(sevenOfTen.jaccard, 0.7);
  assert.equal(sevenOfTen.duplicate, true);

  const sixOfTen = fileSetSimilarity(numbered(8), numbered(8, 2));
  assert.equal(sixOfTen.shared.length, 6);
  assert.equal(sixOfTen.jaccard, 0.6);
  assert.equal(sixOfTen.subset, false);
  assert.equal(sixOfTen.duplicate, false);

  const contained = fileSetSimilarity(["src/a.js", "src/b.js"], ["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js"]);
  assert.equal(contained.subset, true);
  assert.ok(contained.jaccard < 0.7);
  assert.equal(contained.duplicate, true);

  const oneFile = fileSetSimilarity(["src/a.js"], ["src/a.js", "src/b.js", "src/c.js"]);
  assert.equal(oneFile.duplicate, false);

  const noise = fileSetSimilarity(
    ["docs/openapi.yaml", "server/store.mjs", "src/real.js"],
    ["docs/openapi.yaml", "server/http.mjs", "./src/other.js"],
  );
  assert.deepEqual(noise.shared, []);
  assert.equal(noise.duplicate, false);

  const normalized = fileSetSimilarity(["./src/a.js", "src/b.js"], ["src\\a.js", "src/b.js"]);
  assert.equal(normalized.duplicate, true);
  assert.deepEqual(findDuplicatePulls(
    { number: 4, files: ["src/a.js", "src/b.js"] },
    [{ number: 4, files: ["src/a.js", "src/b.js"] }],
  ), []);
});

test("a cited claim or task skips the duplicate check; a missing citation reports it", () => {
  const subject = { number: 1, files: ["src/a.js", "src/b.js"] };
  const others = [{ number: 2, title: "Same files", files: ["src/a.js", "src/b.js"] }];
  for (const body of [
    "See /work-claims/task-1 before review.",
    "claim: task-1",
    "task: task-1",
    'claimId: "task-1"',
    "<!-- claim: task-1 -->",
    "<!-- task: task-1 -->",
  ]) {
    const cited = claimFirstReport({ body, subject, others });
    assert.equal(cited.cited, true, body);
    assert.deepEqual(cited.ids, ["task-1"]);
    assert.deepEqual(cited.duplicates, []);
    assert.equal(cited.comment, null);
  }
  const missing = claimFirstReport({
    body: "Fixes the gate. claim without a colon.",
    subject: { number: 1, title: "Mine", files: ["src/a.js", "src/b.js", "src/c.js"] },
    others: [
      { number: 2, title: "Same files", files: [{ filename: "src/a.js" }, { path: "src/b.js" }, "src/c.js"] },
      { number: 3, title: "Different", files: ["src/z.js"] },
    ],
  });
  assert.equal(missing.cited, false);
  assert.deepEqual(missing.duplicates.map(hit => hit.number), [2]);
  assert.match(missing.comment, /\/work-claims\/<id>/);
  assert.match(missing.comment, /claim: <id>/);
  assert.match(missing.comment, /task: <id>/);
  assert.match(missing.comment, /#2 Same files/);
  assert.doesNotMatch(missing.comment, /#3/);
  assert.match(missing.comment, /<!-- pr-claim-first -->/);
  assert.match(missing.comment, /does not block review/);
});

test("the author cap labels a sixth open pull and leaves the fifth alone", () => {
  const under = authorCapDecision({ open: 5, author: "ada", number: 9 });
  assert.equal(under.cap, DEFAULT_OPEN_PR_CAP);
  assert.equal(under.over, false);
  assert.equal(under.blocking, false);
  assert.equal(under.label, null);
  assert.equal(under.removeLabel, "throughput");
  assert.equal(under.comment, null);

  const over = authorCapDecision({ open: 6, author: "ada", number: 9 });
  assert.equal(over.over, true);
  assert.equal(over.blocking, false);
  assert.equal(over.label, "throughput");
  assert.match(over.comment, /ada has 6 open pull requests/);
  assert.match(over.comment, /throughput signal/);
  assert.match(over.comment, /Finish, rebase, or land/);
  assert.match(over.comment, /does not fail/);
  assert.match(over.comment, /<!-- pr-throughput -->/);
});

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const SHA = "ab".repeat(20);
const ago = hours => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

function pull(overrides = {}) {
  return {
    number: 10,
    title: "Fix the gate",
    author: { login: "ada" },
    headRefName: "ada/fix",
    headRefOid: SHA,
    labels: [],
    commits: [{ committedDate: ago(STALE_QUIET_HOURS) }],
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    mergeable: "MERGEABLE",
    ...overrides,
  };
}

test("stale close waits 72 hours, then closes red or conflicting pulls, and skips keep and ready-to-land", () => {
  const cases = [
    ["71h and red", { commits: [{ committedDate: ago(71) }], statusCheckRollup: [{ conclusion: "FAILURE" }] }, null],
    ["72h and red", { statusCheckRollup: [{ conclusion: "FAILURE" }] }, "red"],
    ["72h and error", { statusCheckRollup: [{ conclusion: "ERROR" }] }, "red"],
    ["72h and timed out", { statusCheckRollup: [{ conclusion: "TIMED_OUT" }] }, "red"],
    ["72h and failed", { statusCheckRollup: [{ conclusion: "FAILED" }] }, "red"],
    ["72h and green", {}, null],
    ["72h and cancelled", { statusCheckRollup: [{ conclusion: "CANCELLED" }] }, null],
    ["72h and skipped", { statusCheckRollup: [{ conclusion: "SKIPPED" }] }, null],
    ["72h and pending", { statusCheckRollup: [{ status: "IN_PROGRESS" }] }, null],
    ["72h and conflicting", { mergeable: "CONFLICTING" }, "conflicts"],
    ["72h and not mergeable", { mergeable: false }, "conflicts"],
    ["72h and unknown mergeable", { mergeable: "UNKNOWN" }, null],
    ["72h red and conflicting", { statusCheckRollup: [{ conclusion: "FAILURE" }], mergeable: "CONFLICTING" }, "red_and_conflicts"],
    ["labeled keep", { labels: [{ name: "keep" }], statusCheckRollup: [{ conclusion: "FAILURE" }] }, null],
    ["labeled ready-to-land", { labels: ["ready-to-land"], statusCheckRollup: [{ conclusion: "FAILURE" }] }, null],
    ["no commit timestamp", { commits: [] }, null],
  ];
  for (const [name, overrides, reason] of cases) {
    const close = planStaleClose([pull(overrides)], NOW).close;
    if (reason === null) {
      assert.deepEqual(close, [], name);
      continue;
    }
    assert.equal(close.length, 1, name);
    assert.equal(close[0].reason, reason, name);
    assert.match(close[0].comment, new RegExp(`Head SHA: \`${SHA}\``), name);
    assert.match(close[0].comment, /<!-- pr-stale-close -->/, name);
    assert.match(close[0].row, new RegExp(`\\| #10 \\|`), name);
    assert.match(close[0].row, new RegExp(`\`${SHA}\``), name);
  }
  const red = planStaleClose([pull({ statusCheckRollup: [{ conclusion: "FAILURE" }] })], NOW).close[0];
  assert.match(red.comment, new RegExp(`git fetch origin pull/10/head && git push origin ${SHA}:refs/heads/ada/fix`));
  const unsafe = planStaleClose([pull({
    headRefName: "ada fix",
    statusCheckRollup: [{ conclusion: "FAILURE" }],
  })], NOW).close[0];
  assert.match(unsafe.comment, /git fetch origin pull\/10\/head/);
  assert.match(unsafe.comment, /<branch>/);
  assert.doesNotMatch(unsafe.comment, /refs\/heads\/ada fix/);
});

test("archive rows already on main are kept once, and rows from the archive branch survive a rebuild", () => {
  const sha = "a".repeat(40);
  const row = number => `| #${number} | title ${number} | \`branch-${number}\` | \`${sha}\` | checks are red and no commits for 72 hours |`;
  const main = [
    "# Archived work",
    "",
    "| PR | Title / idea | Branch | Head SHA | Why closed |",
    "|---|---|---|---|---|",
    row(1),
    "",
    "## Branches with no PR",
    "",
    "| Branch | Head SHA |",
    "|---|---|",
    "",
  ].join("\n");
  const previous = `${main}${row(2)}\n${row(4)}\n`;
  const merged = mergeArchivedWork(main, previous, [{ row: row(2) }, { row: row(3) }, "not a row"]);
  assert.ok(merged.indexOf(row(1)) < merged.indexOf(row(2)));
  assert.ok(merged.indexOf(row(2)) < merged.indexOf(row(4)));
  assert.ok(merged.indexOf(row(4)) < merged.indexOf(row(3)));
  assert.ok(merged.indexOf(row(3)) < merged.indexOf("## Branches with no PR"));
  assert.equal(merged.split(row(2)).length, 2);
  const again = mergeArchivedWork(main, merged, [{ row: row(3) }]);
  assert.equal(again, merged.endsWith("\n") ? merged : `${merged}\n`);
  assert.equal(mergeArchivedWork(main, main, []), main);
});

function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("the workflow commands read the same cap, citation, and archive decisions", () => {
  const cap = JSON.parse(run(["cap", "--open", "6", "--author", "ada", "--number", "9"]));
  assert.equal(cap.over, true);
  assert.equal(cap.blocking, false);
  assert.equal(cap.label, "throughput");
  assert.match(cap.comment, /Finish, rebase, or land/);

  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pr-guardrails-"));
  try {
    const sha = "c".repeat(40);
    const input = join(dir, "open.json");
    writeFileSync(input, JSON.stringify([{
      number: 11,
      title: "Red gate",
      headRefName: "ada/red",
      headRefOid: sha,
      labels: [],
      commits: [{ committedDate: ago(STALE_QUIET_HOURS) }],
      statusCheckRollup: [{ conclusion: "FAILURE" }],
      mergeable: "MERGEABLE",
    }]));
    const comments = join(dir, "comments");
    const plan = JSON.parse(run(["stale-plan", "--input", input, "--now", new Date(NOW).toISOString(), "--comments-dir", comments]));
    assert.equal(plan.close.length, 1);
    assert.equal(plan.quietHours, 72);
    assert.match(readFileSync(join(comments, "11.md"), "utf8"), new RegExp(sha));

    const mainPath = join(dir, "main.md");
    const previousPath = join(dir, "previous.md");
    const rowsPath = join(dir, "rows.json");
    const outPath = join(dir, "out.md");
    const row = number => `| #${number} | title ${number} | \`branch-${number}\` | \`${sha}\` | checks are red and no commits for 72 hours |`;
    const main = `# Archived work\n\n| PR | Title / idea | Branch | Head SHA | Why closed |\n|---|---|---|---|---|\n${row(1)}\n\n## Branches with no PR\n`;
    writeFileSync(mainPath, main);
    writeFileSync(previousPath, `${main}${row(8)}\n`);
    writeFileSync(rowsPath, JSON.stringify([{ row: row(8) }, { row: row(9) }]));
    run(["archive-merge", "--main", mainPath, "--previous", previousPath, "--rows", rowsPath, "--out", outPath]);
    const out = readFileSync(outPath, "utf8");
    assert.ok(out.indexOf(row(8)) < out.indexOf(row(9)));
    assert.ok(out.indexOf(row(9)) < out.indexOf("## Branches with no PR"));
    assert.equal(out.split(row(8)).length, 2);
    const second = join(dir, "out-2.md");
    run(["archive-merge", "--main", mainPath, "--previous", outPath, "--rows", rowsPath, "--out", second]);
    assert.equal(readFileSync(second, "utf8"), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
