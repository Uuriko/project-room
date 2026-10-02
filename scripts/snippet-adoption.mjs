import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Weekly count of public repos that carry the coordination marker or the
// hosted MCP URL. Figures come from the GitHub code-search response and, when
// star or push fields are missing there, from GET /repos/{owner}/{repo}.
// Code search allows 10 requests per minute, so search calls are spaced
// past that ceiling. A missing ADOPTION_SEARCH_TOKEN falls back to
// GITHUB_TOKEN; if that token cannot search public code, the process exits 0.

export const SEARCH_INTERVAL_MS = 6_500;
export const SEARCH_PAGE_SIZE = 100;
export const SEARCH_RESULT_CAP = 1_000;
export const GITHUB_API = "https://api.github.com";

export const ADOPTION_QUERIES = Object.freeze([
  Object.freeze({ id: "agents_md", q: '"project-room:coordination" filename:AGENTS.md' }),
  Object.freeze({ id: "claude_md", q: '"project-room:coordination" filename:CLAUDE.md' }),
  Object.freeze({ id: "conventions_md", q: '"project-room:coordination" filename:CONVENTIONS.md' }),
  Object.freeze({ id: "cursorrules", q: '"project-room:coordination" filename:.cursorrules' }),
  Object.freeze({ id: "mcp", q: '"room.trydemigod.com/mcp"' }),
]);

const sleep = ms => new Promise(done => { setTimeout(done, ms); });

export function redact(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets ?? []) {
    if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function markerVersion(fragments) {
  let best = null;
  for (const fragment of fragments ?? []) {
    for (const match of String(fragment).matchAll(/project-room:coordination\s+v(\d+)/gi)) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && (best === null || n > best)) best = n;
    }
  }
  return best === null ? null : `v${best}`;
}

export function isSelfRepo(fullName) {
  return /^uuriko\//i.test(String(fullName ?? ""));
}

export function weekDiff(currentNames, previousNames) {
  const current = new Set(currentNames);
  const previous = new Set(previousNames);
  const added = [...current].filter(name => !previous.has(name)).sort();
  const lost = [...previous].filter(name => !current.has(name)).sort();
  return {
    new_repos: added,
    lost_repos: lost,
    new_this_week: added.length,
    lost_this_week: lost.length,
  };
}

export function topByStars(repos, limit = 10) {
  return repos
    .filter(repo => Number.isFinite(repo.stars))
    .sort((a, b) => b.stars - a.stars || a.full_name.localeCompare(b.full_name))
    .slice(0, limit)
    .map(repo => ({ full_name: repo.full_name, stars: repo.stars }));
}

export function unzipEntries(buffer) {
  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const entries = [];
  let offset = 0;
  while (offset + 30 <= view.length) {
    const signature = view.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) break;
    const method = view.readUInt16LE(offset + 8);
    const compressedSize = view.readUInt32LE(offset + 18);
    const nameLength = view.readUInt16LE(offset + 26);
    const extraLength = view.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = view.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > view.length) break;
    const compressed = view.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`unsupported zip method ${method}`);
    entries.push({ name, data });
    offset = dataEnd;
  }
  return entries;
}

export function reportFromZip(buffer) {
  for (const entry of unzipEntries(buffer)) {
    if (!entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(entry.data.toString("utf8"));
      if (parsed && Array.isArray(parsed.repos)) return parsed;
    } catch { /* another entry may be the report */ }
  }
  return null;
}

function githubHeaders(credential) {
  return {
    accept: "application/vnd.github.text-match+json",
    authorization: `Bearer ${credential}`,
    "user-agent": "project-room-snippet-adoption",
    "x-github-api-version": "2022-11-28",
  };
}

function isRateLimit(status, headers, body) {
  if (status === 429) return true;
  const remaining = headers?.get?.("x-ratelimit-remaining");
  if ((status === 403 || status === 429) && remaining === "0") return true;
  return /rate limit/i.test(String(body?.message ?? ""));
}

function isSearchRefusal(status, body) {
  if (status === 401) return true;
  if (status !== 403) return false;
  return !/rate limit/i.test(String(body?.message ?? ""));
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { message: text.slice(0, 200) }; }
}

async function githubRequest(url, { credential, fetchImpl, sleepImpl, binary = false }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetchImpl(url, { headers: githubHeaders(credential) });
    if (binary && response.status === 200) {
      return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) };
    }
    const body = binary ? {} : await readJson(response);
    if (isRateLimit(response.status, response.headers, body) && attempt < 3) {
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000;
      await sleepImpl(wait);
      continue;
    }
    return { status: response.status, body, buffer: null };
  }
  return { status: 429, body: { message: "code search rate limit" }, buffer: null };
}

function recordFromItem(item, queryId) {
  const repo = item?.repository ?? {};
  const fullName = typeof repo.full_name === "string" ? repo.full_name : "";
  if (!fullName || !fullName.includes("/")) return null;
  const fragments = (Array.isArray(item.text_matches) ? item.text_matches : [])
    .map(match => match?.fragment)
    .filter(fragment => typeof fragment === "string");
  return {
    full_name: fullName,
    stars: Number.isFinite(repo.stargazers_count) ? repo.stargazers_count : null,
    pushed_at: typeof repo.pushed_at === "string" ? repo.pushed_at : null,
    fork: repo.fork === true,
    forkKnown: typeof repo.fork === "boolean",
    path: typeof item.path === "string" ? item.path : "",
    marker_version: markerVersion(fragments),
    query: queryId,
  };
}

function mergeRecords(records) {
  const files = [];
  const seen = new Set();
  for (const record of records) {
    const key = `${record.query}\0${record.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ path: record.path, marker_version: record.marker_version, query: record.query });
  }
  const versions = files.map(file => file.marker_version).filter(Boolean)
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  const marker = versions[0] ?? null;
  const primary = files.find(file => file.marker_version === marker) ?? files[0];
  return {
    full_name: records[0].full_name,
    stars: records.find(record => record.stars !== null)?.stars ?? null,
    pushed_at: records.find(record => record.pushed_at)?.pushed_at ?? null,
    fork: records.some(record => record.fork),
    forkKnown: records.every(record => record.forkKnown),
    file_path: primary?.path ?? "",
    marker_version: marker,
    files,
  };
}

export async function collectCodeSearch({
  credential,
  fetchImpl,
  sleepImpl = sleep,
  queries = ADOPTION_QUERIES,
  pageSize = SEARCH_PAGE_SIZE,
  cap = SEARCH_RESULT_CAP,
  api = GITHUB_API,
} = {}) {
  const grouped = new Map();
  const cappedQueries = [];
  let incomplete = false;
  let searches = 0;
  for (const query of queries) {
    const collected = [];
    let total = null;
    for (let page = 1; collected.length < cap; page++) {
      if (searches > 0) await sleepImpl(SEARCH_INTERVAL_MS);
      searches += 1;
      const url = `${api}/search/code?q=${encodeURIComponent(query.q)}&per_page=${pageSize}&page=${page}`;
      const { status, body } = await githubRequest(url, { credential, fetchImpl, sleepImpl });
      if (isSearchRefusal(status, body)) return { refused: true, status, message: String(body?.message ?? "") };
      if (status !== 200) {
        const message = String(body?.message ?? `code search failed (${status})`);
        return { error: true, status, message };
      }
      if (body?.incomplete_results === true) incomplete = true;
      if (Number.isFinite(body?.total_count)) total = body.total_count;
      const items = Array.isArray(body?.items) ? body.items : [];
      for (const item of items) {
        if (collected.length >= cap) break;
        const record = recordFromItem(item, query.id);
        if (record) collected.push(record);
      }
      if (items.length < pageSize) break;
      if (total !== null && page * pageSize >= total) break;
    }
    if (total !== null && total > collected.length && collected.length >= cap) cappedQueries.push(query.id);
    for (const record of collected) {
      if (isSelfRepo(record.full_name) || record.fork) continue;
      const list = grouped.get(record.full_name) ?? [];
      list.push(record);
      grouped.set(record.full_name, list);
    }
  }
  const repos = [...grouped.values()].map(mergeRecords).sort((a, b) => a.full_name.localeCompare(b.full_name));
  return { repos, cappedQueries, incomplete, searches };
}

async function hydrateRepos(repos, { credential, fetchImpl, sleepImpl, api }) {
  const cache = new Map();
  const hydrated = [];
  for (const repo of repos) {
    if (repo.forkKnown && repo.stars !== null && repo.pushed_at) {
      hydrated.push(repo);
      continue;
    }
    if (!cache.has(repo.full_name)) {
      const { status, body } = await githubRequest(`${api}/repos/${repo.full_name}`, { credential, fetchImpl, sleepImpl });
      if (status === 200 && body) {
        cache.set(repo.full_name, {
          stars: Number.isFinite(body.stargazers_count) ? body.stargazers_count : repo.stars,
          pushed_at: typeof body.pushed_at === "string" ? body.pushed_at : repo.pushed_at,
          fork: body.fork === true,
        });
      } else {
        cache.set(repo.full_name, { stars: repo.stars, pushed_at: repo.pushed_at, fork: repo.fork });
      }
    }
    const extra = cache.get(repo.full_name);
    hydrated.push({ ...repo, ...extra });
  }
  return hydrated.filter(repo => repo.fork !== true);
}

export function publicRepo(repo) {
  return {
    full_name: repo.full_name,
    stars: repo.stars,
    pushed_at: repo.pushed_at,
    file_path: repo.file_path,
    marker_version: repo.marker_version,
    files: repo.files,
  };
}

export function summarizeRepos(repos, previous) {
  const ranked = topByStars(repos);
  const base = {
    total_repos: repos.length,
    repos_with_at_least_100_stars: repos.filter(repo => Number.isFinite(repo.stars) && repo.stars >= 100).length,
    top_10_by_stars: ranked,
  };
  if (!previous) {
    return { ...base, new_this_week: null, lost_this_week: null, new_repos: [], lost_repos: [], baseline: "none" };
  }
  const diff = weekDiff(repos.map(repo => repo.full_name), (previous.repos ?? []).map(repo => repo.full_name).filter(Boolean));
  return { ...base, ...diff, baseline: typeof previous.date === "string" ? previous.date : "artifact" };
}

function artifactDate(name) {
  const match = /^adoption-(\d{4}-\d{2}-\d{2})$/.exec(String(name ?? ""));
  return match ? match[1] : null;
}

export async function loadPreviousReport({
  credential,
  repo,
  beforeDate,
  fetchImpl,
  sleepImpl = sleep,
  api = GITHUB_API,
} = {}) {
  if (!credential || !repo) return { report: null, reason: "no artifact token" };
  const artifacts = [];
  for (let page = 1; page <= 10; page++) {
    const { status, body } = await githubRequest(
      `${api}/repos/${repo}/actions/artifacts?per_page=100&page=${page}`,
      { credential, fetchImpl, sleepImpl },
    );
    if (status !== 200) return { report: null, reason: `artifact list failed (${status})` };
    const batch = Array.isArray(body?.artifacts) ? body.artifacts : [];
    artifacts.push(...batch);
    if (batch.length < 100) break;
  }
  const candidates = artifacts
    .filter(artifact => artifact?.expired !== true)
    .map(artifact => ({ artifact, date: artifactDate(artifact.name) }))
    .filter(row => row.date && row.date < beforeDate)
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.artifact.created_at ?? "").localeCompare(String(a.artifact.created_at ?? "")));
  const chosen = candidates[0];
  if (!chosen) return { report: null, reason: "no previous artifact" };
  const download = chosen.artifact.archive_download_url
    || `${api}/repos/${repo}/actions/artifacts/${chosen.artifact.id}/zip`;
  const { status, buffer } = await githubRequest(download, { credential, fetchImpl, sleepImpl, binary: true });
  if (status !== 200 || !buffer) return { report: null, reason: `artifact download failed (${status})` };
  let report;
  try { report = reportFromZip(buffer); }
  catch { return { report: null, reason: "artifact zip could not be read" }; }
  if (!report) return { report: null, reason: "artifact had no adoption report" };
  return { report, name: chosen.artifact.name };
}

export function adoptionOpsText(report) {
  const summary = report.summary;
  const diff = summary.baseline === "none"
    ? "no previous artifact"
    : `${summary.new_this_week} new, ${summary.lost_this_week} lost (baseline ${summary.baseline})`;
  const cap = report.capped_queries?.length ? ` A query hit the ${SEARCH_RESULT_CAP}-result cap.` : "";
  const top = summary.top_10_by_stars.map(repo => `${repo.full_name} (${repo.stars})`).join(", ");
  return `Snippet adoption ${report.date}: ${summary.total_repos} repos, ${diff}, ${summary.repos_with_at_least_100_stars} with at least 100 stars.${cap}${top ? ` Top by stars: ${top}.` : ""}`;
}

export function adoptionSummaryMarkdown(report) {
  const summary = report.summary;
  const diffCell = summary.baseline === "none" ? "no previous artifact" : String(summary.new_this_week);
  const lostCell = summary.baseline === "none" ? "no previous artifact" : String(summary.lost_this_week);
  const lines = [
    `## Snippet adoption ${report.date}`,
    "",
    "| | |",
    "| --- | --- |",
    `| Repos | ${summary.total_repos} |`,
    `| New this week | ${diffCell} |`,
    `| Lost this week | ${lostCell} |`,
    `| At least 100 stars | ${summary.repos_with_at_least_100_stars} |`,
    `| Baseline | ${summary.baseline} |`,
    `| Auth | ${report.auth} |`,
  ];
  if (report.capped_queries?.length) lines.push(`| Capped queries | ${report.capped_queries.join(", ")} |`);
  if (report.incomplete) lines.push("| Incomplete | a search page reported incomplete_results |");
  if (summary.top_10_by_stars.length) {
    lines.push("", "### Top by stars", "", "| Repo | Stars |", "| --- | --- |");
    for (const repo of summary.top_10_by_stars) lines.push(`| ${repo.full_name} | ${repo.stars} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function resolveIngestPath() {
  try {
    const mod = await import("../server/analytics-ingest.mjs");
    const path = mod?.INGEST_PATH;
    return typeof path === "string" && path.startsWith("/") ? path : null;
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

async function postJson({ url, credential, body, fetchImpl }) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return response.status;
}

export async function postOpsSummary({ origin, roomId, credential, text, fetchImpl }) {
  if (!credential) return { posted: false, reason: "ROOM_OPS_POST_TOKEN not set" };
  if (!roomId) return { posted: false, reason: "ROOM_OPS_ROOM_ID not set" };
  const id = randomUUID();
  const status = await postJson({
    url: `${origin.replace(/\/$/, "")}/api/rooms/${encodeURIComponent(roomId)}/commands`,
    credential,
    fetchImpl,
    body: { id, type: "message.posted", data: { messageId: id, body: text } },
  });
  return { posted: status === 200 || status === 201, status };
}

export async function postAnalyticsSnapshot({ origin, ingestPath, credential, event, fetchImpl }) {
  if (!ingestPath) return { sent: false, reason: "analytics ingestion route is absent" };
  if (!credential) return { sent: false, reason: "ANALYTICS_INGEST_TOKEN not set" };
  const status = await postJson({
    url: `${origin.replace(/\/$/, "")}${ingestPath}`,
    credential,
    fetchImpl,
    body: event,
  });
  return { sent: status === 200 || status === 201 || status === 202, status };
}

function adoptionEvent(report) {
  const summary = report.summary;
  return {
    type: "adoption.snapshot",
    date: report.date,
    total_repos: summary.total_repos,
    new_this_week: summary.new_this_week,
    lost_this_week: summary.lost_this_week,
    repos_with_at_least_100_stars: summary.repos_with_at_least_100_stars,
    capped: report.capped_queries.length > 0,
    incomplete: report.incomplete === true,
  };
}

export async function runAdoption({
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  now = new Date(),
  outPath = "",
  repo = "",
  queries = ADOPTION_QUERIES,
  pageSize = SEARCH_PAGE_SIZE,
  cap = SEARCH_RESULT_CAP,
  ingestPath,
  api = GITHUB_API,
} = {}) {
  const secrets = [env.ADOPTION_SEARCH_TOKEN, env.GITHUB_TOKEN, env.ROOM_OPS_POST_TOKEN, env.ANALYTICS_INGEST_TOKEN]
    .map(value => String(value ?? "").trim())
    .filter(Boolean);
  const lines = [];
  const say = line => { lines.push(redact(line, secrets)); };
  const dedicated = String(env.ADOPTION_SEARCH_TOKEN ?? "").trim();
  const fallback = String(env.GITHUB_TOKEN ?? "").trim();
  if (!dedicated && !fallback) {
    say("skipped: ADOPTION_SEARCH_TOKEN not set");
    return { exitCode: 0, lines, report: null };
  }
  const credential = dedicated || fallback;
  const auth = dedicated ? "ADOPTION_SEARCH_TOKEN" : "GITHUB_TOKEN";
  const date = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const collected = await collectCodeSearch({ credential, fetchImpl, sleepImpl, queries, pageSize, cap, api });
  if (collected.refused) {
    if (!dedicated) {
      say("skipped: ADOPTION_SEARCH_TOKEN not set");
      return { exitCode: 0, lines, report: null };
    }
    say(`code search refused ADOPTION_SEARCH_TOKEN (${collected.status})`);
    return { exitCode: 1, lines, report: null };
  }
  if (collected.error) {
    say(redact(collected.message, secrets));
    return { exitCode: 1, lines, report: null };
  }
  const hydrated = (await hydrateRepos(collected.repos, { credential, fetchImpl, sleepImpl, api })).map(publicRepo);
  const repository = repo || String(env.GITHUB_REPOSITORY ?? "").trim();
  const previous = await loadPreviousReport({
    credential: fallback,
    repo: repository,
    beforeDate: date,
    fetchImpl,
    sleepImpl,
    api,
  });
  const summary = summarizeRepos(hydrated, previous.report);
  const report = {
    date,
    auth,
    queries: queries.map(query => query.q),
    capped_queries: collected.cappedQueries,
    incomplete: collected.incomplete,
    previous_artifact: previous.report ? previous.name ?? null : null,
    previous_note: previous.report ? null : previous.reason,
    repos: hydrated,
    summary,
  };
  const file = outPath || `adoption-${date}.json`;
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = adoptionSummaryMarkdown(report);
  say(adoptionOpsText(report));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  const origin = String(env.ROOM_OPS_ORIGIN ?? "https://room.trydemigod.com").trim();
  const ops = await postOpsSummary({
    origin,
    roomId: String(env.ROOM_OPS_ROOM_ID ?? "").trim(),
    credential: String(env.ROOM_OPS_POST_TOKEN ?? "").trim(),
    text: adoptionOpsText(report),
    fetchImpl,
  });
  if (ops.posted) say(`ops post: ${ops.status}`);
  else if (ops.status) say(`ops post failed: ${ops.status}`);
  const route = ingestPath === undefined ? await resolveIngestPath() : ingestPath;
  const analytics = await postAnalyticsSnapshot({
    origin: String(env.ROOM_ORIGIN ?? origin).trim(),
    ingestPath: route,
    credential: String(env.ANALYTICS_INGEST_TOKEN ?? "").trim(),
    event: adoptionEvent(report),
    fetchImpl,
  });
  report.analytics = analytics.sent ? { sent: true, status: analytics.status } : { sent: false, reason: analytics.reason ?? `status ${analytics.status}` };
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  if (!analytics.sent) say(`adoption.snapshot not sent: ${analytics.reason ?? analytics.status}`);
  return { exitCode: 0, lines, report, file };
}

function parseArgs(argv) {
  const opts = { outPath: "", repo: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") opts.outPath = argv[++i] ?? "";
    else if (argv[i] === "--repo") opts.repo = argv[++i] ?? "";
    else if (argv[i] === "--date") {
      const day = argv[++i] ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--date must be YYYY-MM-DD");
      opts.now = new Date(`${day}T00:00:00Z`);
    }
  }
  return opts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runAdoption(args);
  for (const line of result.lines) console.log(line);
  process.exit(result.exitCode);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch(error => { console.error(redact(error?.message ?? error, [process.env.ADOPTION_SEARCH_TOKEN, process.env.GITHUB_TOKEN])); process.exit(1); });
