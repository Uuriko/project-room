// The weekly job publishes the probe table to a docs-committed file.
// A probe run renders a docs section carrying the measured paths and the
// run timestamp; publishing a second run puts it above the first and keeps
// the earlier runs. Fails if the publisher overwrites, reorders, or drops
// the timestamp or the measured rows.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRunSection, publishRunSection } from "../scripts/onboarding-probe/docs-publish.mjs";

function fixtureResult(overrides = {}) {
  return {
    runAt: "2026-10-12T15:04:05.000Z",
    target: "https://room.trydemigod.com",
    sourceRevision: "51803999",
    ready: { medianMs: 90, inconclusive: false },
    runs: [],
    paths: {},
    ...overrides,
  };
}

const TABLE = [
  "| Path | Current | 4-week median | Delta |",
  "| --- | --- | --- | --- |",
  "| agentDocs | 588 ms, 5 calls | 770 ms, 5 calls | -23.6% |",
  "| agentMcp | unreachable | | |",
  "",
].join("\n");

test("a probe run renders a docs section with the measured paths and the run timestamp", () => {
  const section = renderRunSection({
    result: fixtureResult(),
    table: TABLE,
    mode: "production",
    runId: "37377549785",
    runUrl: "https://github.com/Uuriko/project-room/actions/runs/37377549785",
  });
  assert.match(section, /## 2026-10-12 — production/);
  assert.match(section, /2026-10-12T15:04:05\.000Z/);
  assert.match(section, /\| agentDocs \| 588 ms, 5 calls \|/);
  assert.match(section, /37377549785/);
  assert.match(section, /51803999/);
});

test("published runs land newest first and earlier runs are kept", t => {
  const dir = mkdtempSync(join(tmpdir(), "probe-docs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const docsPath = join(dir, "results.md");
  publishRunSection(docsPath, renderRunSection({
    result: fixtureResult(),
    table: TABLE,
    mode: "production",
    runId: "37377549785",
    runUrl: "https://github.com/Uuriko/project-room/actions/runs/37377549785",
  }));
  const second = fixtureResult({ runAt: "2026-10-19T15:04:05.000Z", sourceRevision: "aaaa1111" });
  publishRunSection(docsPath, renderRunSection({
    result: second,
    table: TABLE,
    mode: "staging",
    runId: "37400000000",
    runUrl: "",
  }));
  const text = readFileSync(docsPath, "utf8");
  assert.match(text, /newest first/i);
  assert.ok(
    text.indexOf("## 2026-10-19 — staging") < text.indexOf("## 2026-10-12 — production"),
    "newer run section must sit above the older one",
  );
  assert.match(text, /51803999/, "first run kept");
  assert.match(text, /aaaa1111/, "second run kept");
});
