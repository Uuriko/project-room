// Weekly directory listing check. Reads docs/listings.json and server.json.
// The one-liner is server.json's description, so a description edit does not
// require a change here.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { latestRegistryServer } from "./server-json-check.mjs";

export const STATUSES = Object.freeze(["listed", "missing", "stale", "unknown"]);
const BOT_WALL = /just a moment|security checkpoint|cf-browser-verification|cf-challenge|attention required/i;
const USER_AGENT = "project-room-listing-check";

function outcome(status, detail, httpStatus) {
  return { status, detail, httpStatus };
}

function isBotWall(status, body) {
  if (status === 429) return true;
  const text = String(body ?? "").slice(0, 4000);
  if (status === 200) return /just a moment|security checkpoint|cf-browser-verification/i.test(text);
  return BOT_WALL.test(text);
}

export function classifyHtml({ status, body, contains, oneLiner }) {
  if (status === 0 || isBotWall(status, body) || status === 401 || status >= 500) {
    const detail = status === 429 ? "429" : isBotWall(status, body) ? "bot wall" : status === 0 ? "request failed" : `HTTP ${status}`;
    return outcome("unknown", detail, status);
  }
  if (status === 404 || status === 410) return outcome("missing", `HTTP ${status}`, status);
  if (status !== 200) return outcome("unknown", `HTTP ${status}`, status);
  const text = String(body ?? "");
  if (oneLiner && text.includes(oneLiner)) return outcome("listed", "one-liner present", status);
  if (oneLiner && contains && text.includes(contains)) {
    return outcome("stale", "page names Project Room and omits the current one-liner", status);
  }
  if (!oneLiner && contains && text.includes(contains)) return outcome("listed", "page contains Project Room", status);
  return outcome("missing", "page does not contain Project Room", status);
}

export function classifyRegistry({ status, body, server }) {
  if (status === 0 || status === 429 || status >= 500) return outcome("unknown", status === 0 ? "request failed" : `HTTP ${status}`, status);
  if (status === 404) return outcome("missing", "not in the registry", status);
  if (status !== 200) return outcome("unknown", `HTTP ${status}`, status);
  let payload;
  try { payload = JSON.parse(body); }
  catch { return outcome("unknown", "registry response was not JSON", status); }
  const latest = latestRegistryServer(payload);
  if (!latest) return outcome("missing", "registry returned no versions", status);
  if (latest.version === server.version && latest.description === server.description) {
    return outcome("listed", latest.version, status);
  }
  return outcome("stale", `registry has ${latest.version}`, status);
}

function searchList(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["servers", "results", "items", "data"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return null;
}

function searchHit(entry, server) {
  if (!entry || typeof entry !== "object") return false;
  const blob = JSON.stringify(entry);
  return blob.includes("io.github.Uuriko/project-room")
    || blob.includes("Uuriko/project-room")
    || blob.includes(server.repository?.url ?? "https://github.com/Uuriko/project-room")
    || blob.includes("room.trydemigod.com/mcp");
}

function searchDescription(entry) {
  return entry.description || entry.short_description || entry.shortDescription || "";
}

export function classifySearch({ status, body, server }) {
  if (status === 0 || status === 401 || status === 403 || status === 429 || status === 410 || status >= 500) {
    const detail = status === 401 ? "API key required" : status === 0 ? "request failed" : `HTTP ${status}`;
    return outcome("unknown", detail, status);
  }
  if (status === 404) return outcome("unknown", "HTTP 404", status);
  if (status !== 200) return outcome("unknown", `HTTP ${status}`, status);
  let payload;
  try { payload = JSON.parse(body); }
  catch { return outcome("unknown", "search response was not JSON", status); }
  const list = searchList(payload);
  if (!list) return outcome("unknown", "search response has no server list", status);
  const hit = list.find(entry => searchHit(entry, server));
  if (!hit) return outcome("missing", "search has no Project Room server", status);
  if (searchDescription(hit) === server.description) return outcome("listed", "search description matches", status);
  return outcome("stale", "search hit does not use the current one-liner", status);
}

export function classifyStatus({ status, body, expected = 200, contains }) {
  if (status === 0 || isBotWall(status, body) || status >= 500) {
    const detail = status === 429 ? "429" : isBotWall(status, body) ? "bot wall" : status === 0 ? "request failed" : `HTTP ${status}`;
    return outcome("unknown", detail, status);
  }
  if (status === expected) {
    if (contains && !String(body ?? "").includes(contains)) {
      return outcome("stale", `HTTP ${status} omitted expected text`, status);
    }
    return outcome("listed", `HTTP ${status}`, status);
  }
  if (status === 404 || status === 410) return outcome("missing", `HTTP ${status}`, status);
  return outcome("unknown", `HTTP ${status}`, status);
}

export function classifyPullRequest({ status, body }) {
  if (status === 0 || status === 403 || status === 429 || status >= 500) {
    return outcome("unknown", status === 0 ? "request failed" : `HTTP ${status}`, status);
  }
  if (status === 404) return outcome("missing", "pull request not found", status);
  if (status !== 200) return outcome("unknown", `HTTP ${status}`, status);
  let pull;
  try { pull = JSON.parse(body); }
  catch { return outcome("unknown", "pull request response was not JSON", status); }
  const title = typeof pull.title === "string" ? pull.title : "";
  const namesRoom = title.includes("Project Room") || title.includes("project-room");
  const merged = pull.merged === true || (typeof pull.merged_at === "string" && pull.merged_at.length > 0);
  if (merged) {
    return namesRoom
      ? outcome("listed", "pull request merged", status)
      : outcome("stale", "merged pull request title does not name Project Room", status);
  }
  if (pull.state === "closed") return outcome("missing", "pull request closed", status);
  if (pull.state === "open") return outcome("unknown", "pull request open", status);
  return outcome("unknown", "unrecognized pull request state", status);
}

async function fetchText(url, { fetchImpl, headers }) {
  try {
    const response = await fetchImpl(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(20000)
    });
    return { status: response.status, body: await response.text() };
  } catch {
    return { status: 0, body: "" };
  }
}

function githubPullUrl(row) {
  const repo = row.expect?.repo;
  const number = row.expect?.number;
  if (typeof repo !== "string" || !Number.isInteger(number)) {
    throw new Error(`${row.id} is a github_pr row without repo and number`);
  }
  return `https://api.github.com/repos/${repo}/pulls/${number}`;
}

export async function checkRow(row, { server, fetchImpl = globalThis.fetch, token = "" } = {}) {
  const oneLiner = server?.description;
  const contains = row.expect?.oneLiner ? "Project Room" : row.expect?.contains;
  let url = row.url;
  const headers = { "user-agent": USER_AGENT, accept: row.kind === "html" ? "text/html, */*" : "application/json" };
  if (row.kind === "github_pr") {
    url = githubPullUrl(row);
    headers.accept = "application/vnd.github+json";
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const fetched = await fetchText(url, { fetchImpl, headers });
  let classified;
  if (row.kind === "html") {
    classified = classifyHtml({
      status: fetched.status,
      body: fetched.body,
      contains: contains ?? "Project Room",
      oneLiner: row.expect?.oneLiner ? oneLiner : undefined
    });
  } else if (row.kind === "github_pr") {
    classified = classifyPullRequest(fetched);
  } else if (row.kind === "api" && row.expect?.type === "registry") {
    classified = classifyRegistry({ ...fetched, server });
  } else if (row.kind === "api" && row.expect?.type === "search") {
    classified = classifySearch({ ...fetched, server });
  } else if (row.kind === "api" && row.expect?.type === "status") {
    classified = classifyStatus({
      status: fetched.status,
      body: fetched.body,
      expected: row.expect.status ?? 200,
      contains: row.expect.contains
    });
  } else {
    throw new Error(`${row.id} has an unknown kind or expect.type`);
  }
  if (!STATUSES.includes(classified.status)) throw new Error(`${row.id} classified as ${classified.status}`);
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    group: row.group ?? "directory",
    url: row.url,
    status: classified.status,
    detail: classified.detail,
    httpStatus: classified.httpStatus
  };
}

export async function checkListings(rows, options) {
  const results = [];
  for (const row of rows) results.push(await checkRow(row, options));
  return results;
}

function count(rows, group, status) {
  return rows.filter(row => row.group === group && row.status === status).length;
}

export function renderSummary(rows, post) {
  const lines = [
    "## Listing check",
    "",
    "| Directory | Status | Detail |",
    "| --- | --- | --- |"
  ];
  for (const row of rows) {
    const detail = String(row.detail ?? "").replaceAll("|", "\\|");
    lines.push(`| ${row.title} | ${row.status} | ${detail} |`);
  }
  const directoryCount = rows.filter(row => row.group === "directory").length;
  const roomCount = rows.filter(row => row.group === "room").length;
  lines.push("");
  lines.push(
    `${directoryCount} directory rows: ${count(rows, "directory", "listed")} listed, ${count(rows, "directory", "missing")} missing, ${count(rows, "directory", "stale")} stale, ${count(rows, "directory", "unknown")} unknown.`
  );
  lines.push(
    `${roomCount} Room surfaces: ${count(rows, "room", "listed")} listed, ${count(rows, "room", "missing")} missing, ${count(rows, "room", "stale")} stale, ${count(rows, "room", "unknown")} unknown.`
  );
  lines.push("An open pull request is unknown, and the detail column says so. A 429 or a bot wall is unknown.");
  if (post?.reason) lines.push(post.reason);
  return lines.join("\n");
}

export function commandIdFor(markdown) {
  const hex = createHash("sha256").update(markdown).digest("hex");
  return `listing-${hex.slice(0, 24)}`;
}

export async function postListingSummary({ origin, roomId, token, markdown, fetchImpl = globalThis.fetch }) {
  if (!token) return { attempted: false, posted: false, reason: "ROOM_OPS_POST_TOKEN is not set. Skipped the ops room post." };
  if (!roomId) return { attempted: false, posted: false, reason: "ROOM_OPS_POST_TOKEN is set and ROOM_OPS_ROOM is not. Skipped the ops room post." };
  const id = commandIdFor(markdown);
  let response;
  try {
    response = await fetchImpl(`${origin}/api/rooms/${encodeURIComponent(roomId)}/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": USER_AGENT
      },
      body: JSON.stringify({
        id,
        type: "message.posted",
        data: { messageId: id, body: markdown }
      }),
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    return { attempted: true, posted: false, reason: "Ops room post failed before a response." };
  }
  if (response.status !== 200 && response.status !== 201) {
    return { attempted: true, posted: false, reason: `Ops room post returned HTTP ${response.status}.` };
  }
  return { attempted: true, posted: true, reason: `Posted the table to ${roomId}.` };
}

export function listingExitCode(post) {
  return post?.attempted && !post.posted ? 1 : 0;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const server = JSON.parse(readFileSync(resolve(root, "server.json"), "utf8"));
  const catalog = JSON.parse(readFileSync(resolve(root, "docs/listings.json"), "utf8"));
  const outFlag = process.argv.indexOf("--out");
  const outPath = outFlag === -1 ? resolve(root, "listing-check.json") : resolve(process.argv[outFlag + 1] ?? "");
  const rows = await checkListings(catalog.rows, {
    server,
    token: process.env.GITHUB_TOKEN ?? ""
  });
  const table = renderSummary(rows);
  const post = await postListingSummary({
    origin: process.env.ROOM_ORIGIN || "https://room.trydemigod.com",
    roomId: process.env.ROOM_OPS_ROOM ?? "",
    token: process.env.ROOM_OPS_POST_TOKEN ?? "",
    markdown: table
  });
  const markdown = renderSummary(rows, post);
  const report = {
    checkedAt: new Date().toISOString(),
    server: { name: server.name, version: server.version, description: server.description },
    rows,
    post: { posted: post.posted, reason: post.reason }
  };
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  console.log(markdown);
  process.exit(listingExitCode(post));
}
