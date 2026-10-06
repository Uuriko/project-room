// The daemon contract lives in machine/PROTOCOL.md. This check fails when
// the relay's enroll statuses, frame types, or verified flag drift from that
// file. The behavioral checks in relay.check.mjs do not read the document.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  claimOnSlot, control, enroll, expireCode, linkDaemon, mint, postCall, postRpc, readBody, relayFetch, secret, startRelay,
} from "./harness.mjs";

function wireContract() {
  const text = readFileSync(new URL("../../machine/PROTOCOL.md", import.meta.url), "utf8");
  const sample = JSON.parse(/`200`:\s*```json\s*([\s\S]*?)```/.exec(text)[1]);
  const invalid = /`401` `\{ "error": "([a-z_]+)" \}`/.exec(text)[1];
  const goneLine = text.split("\n").find(line => line.includes("`410`"));
  const gone = [...goneLine.matchAll(/"error": "([a-z_]+)"/g)].map(match => match[1]);
  const frames = [...text.matchAll(/^- `\{ "type": "([a-z]+)"/gm)].map(match => match[1]);
  const allowLine = text.split("\n").find(line => line.startsWith("Default allowlist:"));
  const allow = [...allowLine.matchAll(/`([a-z0-9_.]+)`/g)].map(match => match[1]);
  const hello = Number(/\{ "type": "hello", "protocol": (\d+)/.exec(text)[1]);
  const callId = new RegExp(text.match(/Call ids match `([^`]+)`/)[1]);
  const resultCap = Number(text.match(/at most 4 MiB \((\d+) bytes\)/)[1]);
  return { sample, invalid, gone, frames, allow, hello, callId, resultCap };
}

test("enroll and the machine socket match machine/PROTOCOL.md", async () => {
  const contract = wireContract();
  assert.equal(contract.hello, 1);
  assert.ok(contract.resultCap > 1_048_576);
  assert.deepEqual(contract.frames, ["heartbeat", "halt", "pause", "resume", "bye", "call"]);
  const ctx = await startRelay({ passthrough: true, lockCacheMs: "0" });
  try {
    const before = ctx.room.fetches.length;
    const missing = await enroll(ctx, "not-a-code");
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error, contract.invalid);
    assert.equal(typeof missing.body.error, "string");

    const chat = await mint(ctx, {
      label: "spare", roomId: "commons", ownerMemberId: "owner", inviteCode: "RM-0123456789ABCDEF", profile: "chat",
    });
    assert.equal(chat.status, 422);
    assert.equal(ctx.room.fetches.length, before);

    const minted = await mint(ctx, {
      label: "spare",
      roomId: "commons",
      ownerMemberId: "owner",
      inviteCode: "RM-0123456789ABCDEF",
      displayName: "Room machine",
      profile: "contribute",
      passthroughOptIn: true,
      passthroughCaps: ["desktop.screenshot"],
    });
    assert.equal(minted.status, 201);
    const issued = await enroll(ctx, minted.body.code);
    assert.equal(issued.status, 200);
    for (const key of Object.keys(contract.sample)) assert.equal(Object.hasOwn(issued.body, key), true, key);
    assert.equal(issued.body.label, "spare");
    assert.equal(issued.body.roomId, "commons");
    assert.equal(issued.body.ownerMemberId, "owner");
    assert.equal(issued.body.inviteCode, "RM-0123456789ABCDEF");
    assert.equal(issued.body.displayName, "Room machine");
    assert.equal(issued.body.roomOrigin, ctx.roomOrigin);
    assert.equal(new URL(issued.body.relayUrl).protocol, "wss:");
    assert.equal(new URL(issued.body.relayUrl).pathname, "/v0/machines/link");
    assert.equal(ctx.room.fetches.length, before);
    const used = await enroll(ctx, minted.body.code);
    assert.equal(used.status, 410);
    assert.equal(used.body.error, contract.gone[0]);

    const expiring = await mint(ctx, {
      label: "spare", roomId: "commons", ownerMemberId: "owner", inviteCode: "RM-ABCDEFGHJKMNPQRS",
    });
    assert.equal((await expireCode(ctx, expiring.body.machineId)).status, 200);
    const late = await enroll(ctx, expiring.body.code);
    assert.equal(late.status, 410);
    assert.equal(late.body.error, contract.gone[1]);
    assert.notEqual(late.body.error, used.body.error);

    const aliasMint = await mint(ctx, {
      label: "spare", roomId: "commons", ownerMemberId: "owner", inviteCode: "RM-23456789ABCDEFGH",
    });
    const legacy = await readBody(await relayFetch(ctx, "/enroll", { method: "POST", json: { code: aliasMint.body.code } }));
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.get("deprecation"), "true");
    assert.equal(legacy.body.machineId, aliasMint.body.machineId);
    assert.equal(legacy.body.roomId, "commons");
    assert.equal(new URL(legacy.body.relayUrl).pathname, "/v0/machines/link");
    const queried = await ctx.mf.dispatchFetch(`${ctx.origin}/v0/machines/link?token=1`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${issued.body.machineToken}` },
    });
    assert.equal(queried.status, 401);

    const ada = secret("pri");
    ctx.room.person({ token: ada, memberId: "owner", identityId: "idn_owner", handle: "Ada", rooms: ["commons"] });
    ctx.room.claims("commons", [
      claimOnSlot({ id: "lease1", owner: "owner", machineId: issued.body.machineId, slot: "desk", at: Date.now() - 1000 }),
    ]);
    const seen = [];
    const daemon = await linkDaemon(ctx, issued.body.machineId, issued.body.machineToken, {
      label: "spare",
      protocol: contract.hello,
      answer(msg) {
        seen.push(msg);
        return { ok: true, result: { pad: "a".repeat(1_100_000) } };
      },
    });
    const refused = await postCall(ctx, issued.body.machineId, { tool: "desktop.screenshot", arguments: {} });
    assert.equal(refused.status, 401);
    assert.equal(seen.length, 0);

    const called = await postCall(ctx, issued.body.machineId, { tool: "desktop.screenshot", arguments: {} }, {
      authorization: `Bearer ${ada}`,
    });
    assert.equal(called.status, 200);
    assert.equal(called.body.structuredContent.pad.length, 1_100_000);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "call");
    assert.match(seen[0].id, contract.callId);
    assert.equal(seen[0].tool, "desktop.screenshot");
    assert.deepEqual(seen[0].args, {});
    assert.equal(Object.hasOwn(seen[0], "arguments"), false);
    assert.equal(seen[0].caller.verified, true);
    assert.equal(seen[0].caller.identityId, "idn_owner");
    assert.equal(seen[0].caller.claimId, "lease1");
    assert.equal(seen[0].caller.slot, "desk");

    const halted = await control(ctx, issued.body.machineId, "halt", { epoch: 4 });
    const haltFrame = await daemon.expectFrame("halt");
    assert.equal(halted.body.haltEpoch, 4);
    assert.deepEqual(haltFrame, { type: "halt", epoch: 4 });
    await control(ctx, issued.body.machineId, "resume", {});
    assert.deepEqual(await daemon.expectFrame("resume"), { type: "resume" });

    await control(ctx, issued.body.machineId, "pause", { minutes: 30 });
    assert.deepEqual(await daemon.expectFrame("pause"), { type: "pause", minutes: 30 });
    const paused = await postCall(ctx, issued.body.machineId, { tool: "desktop.screenshot", arguments: {} }, {
      authorization: `Bearer ${ada}`,
    });
    assert.equal(paused.status, 409);
    assert.equal(paused.body.error.code, "paused");
    assert.equal(seen.length, 1);
    // A signed control request is single-use inside the skew window: a
    // byte-identical retry in the same second is indistinguishable from a
    // replay, so the second resume carries a distinct body.
    await control(ctx, issued.body.machineId, "resume", { after: "pause" });
    await daemon.expectFrame("resume");

    await control(ctx, issued.body.machineId, "bye", {});
    assert.deepEqual(await daemon.expectFrame("bye"), { type: "bye" });

    const listed = await postRpc(ctx, issued.body.machineId, { method: "tools/list" }, {
      authorization: `Bearer ${ada}`,
    });
    assert.deepEqual(listed.body.result.tools.map(tool => tool.name), contract.allow);
    assert.equal(contract.allow.includes("shell.host"), false);
  } finally {
    await ctx.dispose();
  }
});
