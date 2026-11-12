import test from "node:test";
import assert from "node:assert/strict";
import { docsCommand } from "../cli/commands/docs.mjs";

const connection = async () => ({ origin: "https://room.example", roomId: "room-one", secret: "synthetic" });
test("docs list preserves bounded continuation and emits JSON", async () => {
  let output;
  await docsCommand(["list", "--limit", "2", "--after", "brief"], { connection, out: value => output = JSON.parse(value), fetchImpl: async (url, options) => {
    assert.equal(url, "https://room.example/api/rooms/room-one/docs?limit=2&after=brief");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer synthetic");
    return Response.json({ docs: [], hasMore: true, nextAfter: "next" });
  } });
  assert.equal(output.nextAfter, "next");
});
test("docs stale writes preserve requested base and are not retried", async () => {
  let calls = 0;
  await assert.rejects(docsCommand(["write", "brief", "--title", "Brief", "--file", "draft.md", "--base-rev", "2"], { connection, readFile: () => "draft", fetchImpl: async (_url, options) => {
    calls++;
    assert.deepEqual(JSON.parse(options.body), { title: "Brief", body: "draft", baseRev: 2 });
    return Response.json({ error: { code: "doc_rev_conflict", message: "Read current revision" } }, { status: 409 });
  } }), /409 doc_rev_conflict/);
  assert.equal(calls, 1);
});
test("docs invalid input never loads credentials or sends a request", async () => {
  for (const args of [["read", "../secret"], ["list", "--limit", "501"], ["list", "--limit", "2", "--limit", "3"], ["write", "brief", "--title", "x", "--file", "x"]]) {
    await assert.rejects(docsCommand(args, { connection: () => { assert.fail("must validate first"); } }));
  }
});
