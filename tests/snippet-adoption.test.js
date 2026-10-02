import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  ADOPTION_QUERIES,
  SEARCH_RESULT_CAP,
  collectCodeSearch,
  markerVersion,
  reportFromZip,
  resolveIngestPath,
  runAdoption,
} from "../scripts/snippet-adoption.mjs";

const script = fileURLToPath(new URL("../scripts/snippet-adoption.mjs", import.meta.url));

function workdir() {
  return mkdtempSync(join(tmpdir(), "adoption-"));
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => body,
    arrayBuffer: async () => Buffer.from(text),
  };
}

function zipResponse(buffer, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => "",
    arrayBuffer: async () => buffer,
  };
}

function zipDeflated(name, text) {
  const raw = Buffer.from(text);
  const data = deflateRawSync(raw);
  const nameBuf = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(raw.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  return Buffer.concat([header, nameBuf, data]);
}

function repoItem(fullName, path, { stars = null, pushedAt = null, fork = false, fragment = null } = {}) {
  const repository = { full_name: fullName, fork };
  if (stars !== null) repository.stargazers_count = stars;
  if (pushedAt) repository.pushed_at = pushedAt;
  const item = { path, repository };
  if (fragment) item.text_matches = [{ fragment }];
  return item;
}

function bearer(init) {
  return init?.headers?.authorization ?? "";
}

test("marker version is the highest vN in the fragment and stays empty when the fragment has none", () => {
  assert.equal(markerVersion(["<!-- project-room:coordination v1 -->", "project-room:coordination v2"]), "v2");
  assert.equal(markerVersion(["project-room:coordination without a version"]), null);
  assert.equal(markerVersion([]), null);
});

test("code search pages until a short page and stops at the 1000 result cap", async () => {
  assert.equal(SEARCH_RESULT_CAP, 1000);
  const pages = [];
  const fetchImpl = async url => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    const items = [0, 1].map(offset => repoItem(`acme/r${(page - 1) * 2 + offset}`, "AGENTS.md", { stars: 1, pushedAt: "2026-01-01T00:00:00Z" }));
    return jsonResponse({ total_count: 10, incomplete_results: false, items });
  };
  const capped = await collectCodeSearch({
    credential: "search-credential",
    fetchImpl,
    sleepImpl: async () => {},
    queries: ADOPTION_QUERIES.slice(0, 1),
    pageSize: 2,
    cap: 3,
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(capped.repos.length, 3);
  assert.deepEqual(capped.cappedQueries, ["agents_md"]);

  const seen = [];
  const paged = await collectCodeSearch({
    credential: "search-credential",
    fetchImpl: async url => {
      const page = Number(new URL(url).searchParams.get("page"));
      seen.push(page);
      const items = page === 1
        ? [repoItem("acme/a", "AGENTS.md", { stars: 1, pushedAt: "2026-01-01T00:00:00Z" }), repoItem("acme/b", "AGENTS.md", { stars: 1, pushedAt: "2026-01-01T00:00:00Z" })]
        : [repoItem("acme/c", "AGENTS.md", { stars: 1, pushedAt: "2026-01-01T00:00:00Z" })];
      return jsonResponse({ total_count: 3, incomplete_results: page === 1, items });
    },
    sleepImpl: async () => {},
    queries: ADOPTION_QUERIES.slice(0, 1),
    pageSize: 2,
    cap: 1000,
  });
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(paged.repos.map(repo => repo.full_name), ["acme/a", "acme/b", "acme/c"]);
  assert.equal(paged.incomplete, true);
  assert.deepEqual(paged.cappedQueries, []);
});

test("search calls wait past the 10-per-minute ceiling", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = runAdoption({
    env: { ADOPTION_SEARCH_TOKEN: "search-credential" },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
    },
    queries: ADOPTION_QUERIES.slice(0, 2),
    outPath: join(workdir(), "adoption.json"),
    now: new Date("2026-10-05T13:00:00Z"),
  });
  await new Promise(done => setImmediate(done));
  assert.equal(calls, 1);
  t.mock.timers.tick(6000);
  await new Promise(done => setImmediate(done));
  assert.equal(calls, 1);
  t.mock.timers.tick(500);
  const result = await pending;
  assert.equal(calls, 2);
  assert.equal(result.exitCode, 0);
});

test("a rate-limit response waits and then keeps the real result", async () => {
  const waits = [];
  let attempt = 0;
  const result = await collectCodeSearch({
    credential: "search-credential",
    sleepImpl: async ms => { waits.push(ms); },
    queries: ADOPTION_QUERIES.slice(0, 1),
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) return jsonResponse({ message: "API rate limit exceeded" }, { status: 403, headers: { "retry-after": "7" } });
      return jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [repoItem("acme/kept", "AGENTS.md", { stars: 4, pushedAt: "2026-08-01T00:00:00Z", fragment: "<!-- project-room:coordination v1 -->" })],
      });
    },
  });
  assert.deepEqual(waits, [7000]);
  assert.equal(result.repos[0].full_name, "acme/kept");
  assert.equal(result.repos[0].marker_version, "v1");
});

test("forks and Uuriko repos drop out, stars come from the repo payload, and the week diff uses the previous artifact", async () => {
  const previous = {
    date: "2026-09-28",
    repos: [{ full_name: "acme/kept" }, { full_name: "gone/old" }],
  };
  const zip = zipDeflated("adoption-2026-09-28.json", JSON.stringify(previous));
  assert.equal(reportFromZip(zip).date, "2026-09-28");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: bearer(init), body: init?.body ?? null });
    if (url.includes("/search/code")) {
      const q = new URL(url).searchParams.get("q");
      const items = q.includes("filename:AGENTS.md")
        ? [
          repoItem("Uuriko/project-room", "AGENTS.md", { stars: 10, pushedAt: "2026-09-01T00:00:00Z", fragment: "<!-- project-room:coordination v1 -->" }),
          repoItem("someone/forked", "AGENTS.md", { stars: 400, pushedAt: "2026-09-01T00:00:00Z", fork: true, fragment: "<!-- project-room:coordination v1 -->" }),
          repoItem("acme/kept", "AGENTS.md", { fragment: "<!-- project-room:coordination v1 -->" }),
          repoItem("plain/repo", "AGENTS.md", { stars: 10, pushedAt: "2026-07-01T00:00:00Z", fragment: "project-room:coordination without a version" }),
        ]
        : q.includes("room.trydemigod.com/mcp")
          ? [repoItem("other/new", ".cursor/mcp.json", { stars: 3, pushedAt: "2026-08-02T00:00:00Z" })]
          : [];
      return jsonResponse({ total_count: items.length, incomplete_results: false, items });
    }
    if (url.includes("/actions/artifacts") && !url.includes("/zip")) {
      return jsonResponse({
        total_count: 3,
        artifacts: [
          { id: 1, name: "adoption-2026-09-21", expired: false, created_at: "2026-09-21T13:00:00Z", archive_download_url: "https://api.github.com/repos/Uuriko/project-room/actions/artifacts/1/zip" },
          { id: 2, name: "adoption-2026-09-28", expired: false, created_at: "2026-09-28T13:00:00Z", archive_download_url: "https://api.github.com/repos/Uuriko/project-room/actions/artifacts/2/zip" },
          { id: 3, name: "adoption-2026-10-05", expired: false, created_at: "2026-10-05T01:00:00Z", archive_download_url: "https://api.github.com/repos/Uuriko/project-room/actions/artifacts/3/zip" },
          { id: 4, name: "adoption-2026-09-14", expired: true, created_at: "2026-09-14T13:00:00Z" },
        ],
      });
    }
    if (url.endsWith("/zip")) return zipResponse(zip);
    if (url.endsWith("/repos/acme/kept")) return jsonResponse({ stargazers_count: 150, pushed_at: "2026-09-01T00:00:00Z", fork: false });
    if (url.includes("/api/rooms/ops-room/commands")) return jsonResponse({ ok: true }, { status: 201 });
    if (url.endsWith("/api/analytics/events")) return jsonResponse({ ok: true }, { status: 202 });
    throw new Error(`unexpected ${url}`);
  };
  const dir = workdir();
  const result = await runAdoption({
    env: {
      ADOPTION_SEARCH_TOKEN: "search-credential",
      GITHUB_TOKEN: "actions-credential",
      GITHUB_REPOSITORY: "Uuriko/project-room",
      ROOM_OPS_POST_TOKEN: "ops-post-credential",
      ROOM_OPS_ROOM_ID: "ops-room",
      ANALYTICS_INGEST_TOKEN: "analytics-cred",
    },
    fetchImpl,
    sleepImpl: async () => {},
    now: new Date("2026-10-05T13:00:00Z"),
    outPath: join(dir, "adoption-2026-10-05.json"),
    ingestPath: "/api/analytics/events",
  });
  assert.equal(result.exitCode, 0);
  const names = result.report.repos.map(repo => repo.full_name);
  assert.deepEqual(names, ["acme/kept", "other/new", "plain/repo"]);
  const kept = result.report.repos.find(repo => repo.full_name === "acme/kept");
  assert.equal(kept.stars, 150);
  assert.equal(kept.pushed_at, "2026-09-01T00:00:00Z");
  assert.equal(kept.file_path, "AGENTS.md");
  assert.equal(kept.marker_version, "v1");
  const fresh = result.report.repos.find(repo => repo.full_name === "other/new");
  assert.equal(fresh.marker_version, null);
  assert.equal(fresh.file_path, ".cursor/mcp.json");
  assert.equal(result.report.repos.find(repo => repo.full_name === "plain/repo").marker_version, null);
  assert.equal(result.report.summary.total_repos, 3);
  assert.equal(result.report.summary.new_this_week, 2);
  assert.equal(result.report.summary.lost_this_week, 1);
  assert.deepEqual(result.report.summary.new_repos, ["other/new", "plain/repo"]);
  assert.deepEqual(result.report.summary.lost_repos, ["gone/old"]);
  assert.equal(result.report.summary.repos_with_at_least_100_stars, 1);
  assert.equal(result.report.summary.top_10_by_stars[0].full_name, "acme/kept");
  assert.equal(result.report.summary.baseline, "2026-09-28");
  assert.equal(result.report.previous_artifact, "adoption-2026-09-28");
  const searchCall = calls.find(call => call.url.includes("/search/code"));
  const artifactCall = calls.find(call => call.url.includes("/actions/artifacts?"));
  const zipCall = calls.find(call => call.url.endsWith("/2/zip"));
  assert.equal(searchCall.authorization, "Bearer search-credential");
  assert.equal(artifactCall.authorization, "Bearer actions-credential");
  assert.equal(zipCall.authorization, "Bearer actions-credential");
  assert.equal(calls.some(call => call.url.endsWith("/repos/Uuriko/project-room")), false);
  assert.equal(calls.some(call => call.url.includes("/repos/someone/")), false);
  const ops = calls.find(call => call.url.includes("/api/rooms/ops-room/commands"));
  assert.equal(ops.authorization, "Bearer ops-post-credential");
  const opsBody = JSON.parse(ops.body);
  assert.match(opsBody.data.body, /3 repos/);
  assert.match(opsBody.data.body, /2 new, 1 lost/);
  assert.equal(opsBody.data.body.includes("ops-post-credential"), false);
  const analytics = calls.find(call => call.url.endsWith("/api/analytics/events"));
  assert.equal(analytics.authorization, "Bearer analytics-cred");
  const event = JSON.parse(analytics.body);
  assert.equal(event.type, "adoption.snapshot");
  assert.equal(event.total_repos, 3);
  assert.equal(event.new_this_week, 2);
  assert.equal(event.lost_this_week, 1);
  assert.equal(event.repos_with_at_least_100_stars, 1);
  const written = JSON.stringify(result.report);
  for (const secret of ["search-credential", "actions-credential", "ops-post-credential", "analytics-cred"]) {
    assert.equal(written.includes(secret), false);
    assert.equal(result.lines.join("\n").includes(secret), false);
  }
});

test("without a previous artifact the week diff stays unknown", async () => {
  const result = await runAdoption({
    env: { ADOPTION_SEARCH_TOKEN: "search-credential" },
    fetchImpl: async url => {
      if (!url.includes("/search/code")) throw new Error(`unexpected ${url}`);
      return jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [repoItem("acme/only", "AGENTS.md", { stars: 9, pushedAt: "2026-08-01T00:00:00Z", fragment: "<!-- project-room:coordination v1 -->" })],
      });
    },
    sleepImpl: async () => {},
    now: new Date("2026-10-05T00:00:00Z"),
    outPath: join(workdir(), "adoption.json"),
  });
  assert.equal(result.report.summary.total_repos, 1);
  assert.equal(result.report.summary.new_this_week, null);
  assert.equal(result.report.summary.lost_this_week, null);
  assert.equal(result.report.summary.baseline, "none");
  assert.match(result.lines.join("\n"), /no previous artifact/);
});

test("a missing search token exits 0 and a refused GITHUB_TOKEN fallback does too", async () => {
  const dir = workdir();
  const skipped = spawnSync(process.execPath, [script], {
    cwd: dir,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /skipped: ADOPTION_SEARCH_TOKEN not set/);

  let called = 0;
  const refused = await runAdoption({
    env: { GITHUB_TOKEN: "actions-credential" },
    fetchImpl: async () => {
      called += 1;
      return jsonResponse({ message: "Resource not accessible by integration" }, { status: 403 });
    },
    outPath: join(dir, "should-not-matter.json"),
  });
  assert.equal(called, 1);
  assert.equal(refused.exitCode, 0);
  assert.match(refused.lines.join("\n"), /skipped: ADOPTION_SEARCH_TOKEN not set/);
  assert.equal(refused.report, null);

  const rejected = await runAdoption({
    env: { ADOPTION_SEARCH_TOKEN: "search-credential" },
    fetchImpl: async () => jsonResponse({ message: "Bad credentials" }, { status: 401 }),
    outPath: join(dir, "rejected.json"),
  });
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.lines.join("\n"), /code search refused ADOPTION_SEARCH_TOKEN \(401\)/);
  assert.equal(rejected.lines.join("\n").includes("search-credential"), false);
  assert.equal(rejected.lines.join("\n").includes("skipped: ADOPTION_SEARCH_TOKEN not set"), false);
});

test("GITHUB_TOKEN can run the public code search when it is accepted", async () => {
  const result = await runAdoption({
    env: { GITHUB_TOKEN: "actions-credential" },
    fetchImpl: async url => {
      if (url.includes("/search/code")) {
        return jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [repoItem("acme/public", "CLAUDE.md", { stars: 12, pushedAt: "2026-08-01T00:00:00Z", fragment: "<!-- project-room:coordination v1 -->" })],
        });
      }
      throw new Error(`unexpected ${url}`);
    },
    sleepImpl: async () => {},
    now: new Date("2026-10-05T00:00:00Z"),
    outPath: join(workdir(), "adoption.json"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.auth, "GITHUB_TOKEN");
  assert.equal(result.report.summary.total_repos, 1);
  assert.equal(result.lines.join("\n").includes("skipped:"), false);
});

test("the analytics ingestion route is absent until its module exists", async () => {
  assert.equal(await resolveIngestPath(), null);
});
