// tests/herdr-migrate-force-release.test.js — #2009: force-release must name
// the missing authority when the release route refuses (403), instead of
// surfacing the raw route error, and must not journal a release that never
// happened.
//
// Tier determination (#2009 pricing, lanes/P3.md): Tier 1 only. The claim
// read carries only the claim's `owner`; no room-API surface returns the
// caller token's member id or permissions, so the script has nothing
// trustworthy to pre-validate against. Tier 2 (a true caller-identity
// pre-check in cmdForceRelease) waits on such a surface existing.
//
// The pure translator + help text are unit-tested here; the CLI behaviour
// runs the real script against a loopback fake room API, like
// tests/herdr-migrate-resume.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { forceReleaseAuthorityError, readJournal, USAGE } from "../scripts/herdr-migrate.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "herdr-migrate.mjs");

const claim = {
  id: "clm_1", title: "stuck work", state: "in_progress", owner: "someone-else",
  claimedAt: "2026-10-06T10:00:00Z", leaseStartAt: "2026-10-06T10:00:00Z",
  leaseExpiresAt: "2999-01-01T00:00:00Z", files: [], reviews: [], history: [],
  sessionBackend: "herdr",
};

test("forceReleaseAuthorityError: a 403 names the missing authority", () => {
  const msg = forceReleaseAuthorityError(
    { status: 403, message: "room API 403 on /release: raw" }, claim);
  assert.match(msg, /operator lacks authority/);
  assert.match(msg, /claim owner/);
  assert.match(msg, /room owner/);
  assert.match(msg, /manage_claims/);
  assert.match(msg, /clm_1/);
  assert.match(msg, /someone-else/);
});

test("forceReleaseAuthorityError: non-403 errors are not translated", () => {
  assert.equal(forceReleaseAuthorityError({ status: 409, message: "x" }, claim), null);
  assert.equal(forceReleaseAuthorityError({ status: 500, message: "x" }, claim), null);
  assert.equal(forceReleaseAuthorityError(new Error("net down"), claim), null);
  assert.equal(forceReleaseAuthorityError(null, claim), null);
});

test("USAGE: force-release help names the authority requirement", () => {
  assert.match(USAGE, /Authority: the --token operator must be the claim owner/);
  assert.match(USAGE, /manage_claims/);
});

async function runForceRelease(t, releaseStatus) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-force-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const journalPath = join(dir, "journal.jsonl");
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/rooms/room-1/work-claims/clm_1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ claim }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/rooms/room-1/work-claims/clm_1/release") {
      if (releaseStatus === 403) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "work_not_owner", message: "Work \"clm_1\" is owned by someone-else — only the owner can change it" } }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ claim: { ...claim, state: "unclaimed" } }));
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const args = [scriptPath, "force-release", "--room", "room-1", "--claim", "clm_1",
    "--execute", "--confirm", "--reason", "stuck pane",
    "--journal", journalPath, "--api-base", base, "--token", "tok-nonowner"];
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("herdr-migrate timed out")); }, 25000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (c) => { clearTimeout(timer); resolve({ code: c, stdout, stderr }); });
  });
  return { code, stdout, stderr, journal: readJournal(journalPath) };
}

test("force-release: a 403 refusal names the missing authority and journals nothing", { timeout: 30000 }, async (t) => {
  const { code, stderr, journal } = await runForceRelease(t, 403);
  assert.equal(code, 2);
  assert.match(stderr, /operator lacks authority over claim clm_1/);
  assert.match(stderr, /manage_claims/);
  assert.equal(journal.filter((e) => e.kind === "force_release").length, 0);
});

test("force-release: an authorised release still succeeds and journals", { timeout: 30000 }, async (t) => {
  const { code, stdout, journal } = await runForceRelease(t, 200);
  assert.equal(code, 0);
  assert.match(stdout, /force-released clm_1/);
  assert.equal(journal.filter((e) => e.kind === "force_release").length, 1);
});
