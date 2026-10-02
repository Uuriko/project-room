import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  claimOnSlot, control, createRoom, enroll, expireCode, finishClaim, leaseToken,
  linkDaemon, machineStatus, mint, postCall, postRpc, readBody, relayFetch, secret, startRelay,
} from "./harness.mjs";

const HOUR = 60 * 60 * 1000;

let on;
let off;

test.before(async () => {
  const room = createRoom();
  [on, off] = await Promise.all([
    startRelay({ passthrough: true, lockCacheMs: "0", room }),
    startRelay({ passthrough: false, lockCacheMs: "0" }),
  ]);
});

test.after(async () => {
  await Promise.all([on?.dispose(), off?.dispose()]);
});

test("healthz stays off until passthrough is set and names missing secrets", async () => {
  const bare = await startRelay({ secrets: false, passthrough: false });
  try {
    const live = await readBody(await relayFetch(bare, "/healthz"));
    assert.equal(live.status, 200);
    assert.equal(live.body.status, "ok");
    assert.equal(live.body.phase0Passthrough, false);
    assert.deepEqual(live.body.missing, ["RELAY_ADMIN_TOKEN", "RELAY_LINK_SECRET", "ROOM_RESOURCE_LEASE_PUBLIC_JWK"]);
    assert.equal(JSON.stringify(live.body).includes("adm_"), false);
    const head = await relayFetch(bare, "/healthz", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    await bare.dispose();
  }

  const enabled = await readBody(await relayFetch(on, "/healthz"));
  const disabled = await readBody(await relayFetch(off, "/healthz"));
  assert.equal(enabled.body.phase0Passthrough, true);
  assert.equal(disabled.body.phase0Passthrough, false);
  assert.deepEqual(disabled.body.missing, []);
});

test("an enroll code works once, expires, and stays bound to its room", async () => {
  const minted = await mint(on, {
    label: "Ada's desk", roomId: "room_alpha", ownerMemberId: "mem_ada", inviteCode: "RM-0123456789ABCDEF", displayName: "Ada desk",
  });
  assert.equal(minted.status, 201);
  const delta = Date.parse(minted.body.expiresAt) - Date.now();
  assert.ok(delta > 14 * 60 * 1000 && delta < 16 * 60 * 1000, `expiresAt was ${delta} ms out`);
  const tampered = `${minted.body.code.slice(0, -1)}${minted.body.code.endsWith("a") ? "b" : "a"}`;
  const refused = await enroll(on, tampered);
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, "code_invalid");
  const issued = await enroll(on, minted.body.code);
  assert.equal(issued.status, 200);
  assert.equal(issued.body.machineId, minted.body.machineId);
  assert.equal(issued.body.roomId, "room_alpha");
  assert.equal(issued.body.inviteCode, "RM-0123456789ABCDEF");
  assert.equal(issued.body.displayName, "Ada desk");
  assert.equal(issued.body.relayUrl, "wss://relay.test/v0/machines/link");
  assert.equal(typeof issued.body.machineToken, "string");
  const again = await enroll(on, minted.body.code);
  assert.equal(again.status, 410);
  assert.equal(again.body.error, "code_used");
  const status = await machineStatus(on, issued.body.machineId);
  assert.deepEqual(status.body.rooms, ["room_alpha"]);
  assert.equal(status.body.label, "Ada's desk");
  assert.equal(status.body.ownerMemberId, "mem_ada");
  assert.equal(status.body.online, false);

  const expiring = await mint(on, { label: "Spare", roomId: "room_alpha", ownerMemberId: "mem_ada", inviteCode: "RM-ABCDEFGHJKMNPQRS" });
  const expired = await expireCode(on, expiring.body.machineId);
  assert.equal(expired.status, 200);
  const late = await enroll(on, expiring.body.code);
  assert.equal(late.status, 410);
  assert.equal(late.body.error, "code_expired");

  const before = on.room.fetches.length;
  const otherRoom = await postCall(on, issued.body.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${secret("pri")}`,
    "x-room-id": "room_other",
  });
  assert.equal(otherRoom.status, 403);
  assert.equal(otherRoom.body.error.code, "room_not_allowed");
  assert.equal(on.room.fetches.length, before);
});

test("a wrong link token is refused and a reconnect replaces the socket", async () => {
  const machine = await enrolledMachine(off);
  const bad = await off.mf.dispatchFetch(`${off.origin}/v0/machines/link`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${machine.machineId}.${secret("nope")}` },
  });
  const refused = await readBody(bad);
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error.code, "unauthenticated");
  assert.match(refused.headers.get("www-authenticate"), /resource_metadata=/);
  assert.equal((await machineStatus(off, machine.machineId)).body.online, false);

  const first = await linkDaemon(off, machine.machineId, machine.machineToken, { answer: () => null });
  const pending = postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId)}`,
  });
  const call = await first.expectFrame("call");
  assert.equal(call.tool, "desktop.screenshot");
  assert.equal(call.caller.verified, true);
  assert.equal(call.caller.slot, "desk");
  assert.equal(call.caller.claimId, "claim_ada");
  assert.deepEqual(call.args, {});
  const second = await linkDaemon(off, machine.machineId, machine.machineToken, {
    answer: () => ({ ok: true, result: { shot: true } }),
  });
  const replaced = await pending;
  assert.equal(replaced.status, 409);
  assert.equal(replaced.body.error.code, "link_replaced");
  const closed = await until(() => first.closeInfo(), 2000);
  assert.equal(closed.code, 4001);
  assert.match(closed.reason, /replaced/);
  const again = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId)}`,
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.isError, false);
  assert.equal(again.body.structuredContent.shot, true);

  second.ws.close();
  await until(async () => (await machineStatus(off, machine.machineId)).body.online === false, 2000);
  const offline = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { jti: "after-close" })}`,
  });
  assert.equal(offline.status, 503);
  assert.equal(offline.body.error.code, "machine_offline");
});

test("halt reaches the daemon within 2 seconds and cancels the in-flight call", async () => {
  const machine = await enrolledMachine(off);
  const daemon = await linkDaemon(off, machine.machineId, machine.machineToken, { answer: () => null });
  const pending = postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId)}`,
  });
  await daemon.expectFrame("call");
  const started = Date.now();
  const halted = await control(off, machine.machineId, "halt", { reason: "operator" });
  const frame = await daemon.expectFrame("halt");
  assert.ok(Date.now() - started < 2000, `halt took ${Date.now() - started} ms`);
  assert.equal(halted.status, 200);
  assert.equal(halted.body.halted, true);
  assert.equal(frame.epoch, halted.body.haltEpoch);
  assert.equal(frame.haltEpoch, undefined);
  const cancelled = await pending;
  assert.equal(cancelled.status, 409);
  assert.equal(cancelled.body.error.code, "halted");
  const mid = await machineStatus(off, machine.machineId);
  assert.equal(mid.body.halted, true);
  assert.equal(mid.body.haltEpoch, frame.epoch);

  const resumed = await control(off, machine.machineId, "resume", {});
  const resumeFrame = await daemon.expectFrame("resume");
  assert.equal(resumed.body.halted, false);
  assert.deepEqual(resumeFrame, { type: "resume" });
  const after = await machineStatus(off, machine.machineId);
  assert.equal(after.body.halted, false);
  assert.equal(after.body.haltEpoch, frame.epoch);
});

test("phase 0 passthrough gives the earliest live work claim the slot", async () => {
  const ada = secret("pri");
  const bea = secret("pri");
  const cam = secret("pri");
  on.room.person({ token: ada, memberId: "mem_ada", identityId: "idn_ada", handle: "Ada", rooms: ["room_alpha"] });
  on.room.person({ token: bea, memberId: "mem_bea", identityId: "idn_bea", handle: "Bea", rooms: ["room_alpha"] });
  on.room.person({ token: cam, memberId: "mem_cam", identityId: "idn_cam", handle: "Cam", rooms: ["room_other"] });
  const machine = await enrolledMachine(on, { rooms: ["room_alpha"], ownerMemberId: "mem_ada" });
  const now = Date.now();
  const claims = [
    claimOnSlot({ id: "claim_land", owner: "mem_bea", machineId: machine.machineId, slot: "desk", at: now - 3 * HOUR, leaseHours: 5, kind: "land" }),
    claimOnSlot({ id: "claim_expired", owner: "mem_bea", machineId: machine.machineId, slot: "desk", at: now - 48 * HOUR, leaseHours: 1 }),
    claimOnSlot({ id: "claim_bea", owner: "mem_bea", machineId: machine.machineId, slot: "desk", at: now - 30_000 }),
    claimOnSlot({ id: "claim_scratch", owner: "mem_bea", machineId: machine.machineId, slot: "scratch", at: now - 20_000 }),
    finishClaim(claimOnSlot({ id: "claim_done", owner: "mem_ada", machineId: machine.machineId, slot: "scratch", at: now - 90_000 }), "mem_ada", now - 80_000),
    claimOnSlot({ id: "claim_ada", owner: "mem_ada", machineId: machine.machineId, slot: "desk", at: now - 60_000 }),
  ];
  on.room.claims("room_alpha", claims);
  const seen = [];
  await linkDaemon(on, machine.machineId, machine.machineToken, {
    answer(msg) {
      seen.push(msg);
      if (msg.tool === "files.get") return { ok: false, error: { code: "missing", message: "no such file" } };
      return { ok: true, result: { shot: true, tool: msg.tool } };
    },
  });
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map(part => typeof part === "string" ? part : String(part)).join(" "));
    original.apply(console, args);
  };
  let client;
  try {
    client = new Client({ name: "relay-check", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${on.origin}/v0/machines/${machine.machineId}/mcp`), {
      fetch: (input, init) => on.mf.dispatchFetch(input instanceof Request ? input : String(input), init),
      requestInit: { headers: { authorization: `Bearer ${ada}` } },
    });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.some(tool => tool.name === "shell.host"), false);
    assert.equal(listed.tools.some(tool => tool.name === "shell.vm.run"), false);
    assert.equal(listed.tools.some(tool => tool.name === "desktop.screenshot"), true);
    assert.equal(listed.tools.some(tool => tool.name === "shell.vm"), true);
    assert.equal(listed.tools.some(tool => tool.name === "files.get"), true);
    const shot = await client.callTool({ name: "desktop.screenshot", arguments: {} });
    assert.equal(shot.isError, false);
    assert.equal(shot.structuredContent.shot, true);
    assert.equal(seen.at(-1).caller.claimId, "claim_ada");
    assert.equal(seen.at(-1).caller.slot, "desk");
    assert.equal(seen.at(-1).caller.identityId, "idn_ada");
    assert.equal(seen.at(-1).caller.verified, true);
    assert.equal(Object.hasOwn(seen.at(-1), "arguments"), false);

    const held = await postRpc(on, machine.machineId, {
      method: "tools/call",
      params: { name: "desktop.screenshot", arguments: {} },
    }, { authorization: `Bearer ${bea}`, "x-machine-slot": "desk" });
    assert.equal(held.status, 409);
    assert.equal(held.body.error.code, "slot_held");
    assert.equal(held.body.error.holder, "Ada");
    assert.match(held.body.error.message, /desk is held by Ada/);

    const scratch = await postCall(on, machine.machineId, { tool: "shell.vm", arguments: { cmd: "true" }, slot: "scratch" }, {
      authorization: `Bearer ${bea}`,
    });
    assert.equal(scratch.status, 200);
    assert.equal(scratch.body.isError, false);
    assert.equal(seen.at(-1).caller.slot, "scratch");
    assert.equal(seen.at(-1).caller.claimId, "claim_scratch");
    assert.equal(seen.at(-1).caller.verified, true);

    const missing = await postCall(on, machine.machineId, { tool: "files.get", arguments: { path: "notes.txt" } }, {
      authorization: `Bearer ${ada}`,
    });
    assert.equal(missing.status, 200);
    assert.equal(missing.body.isError, true);
    assert.equal(missing.body.content[0].text, "no such file");

    const host = await postRpc(on, machine.machineId, {
      method: "tools/call",
      params: { name: "shell.host", arguments: {} },
    }, { authorization: `Bearer ${ada}` });
    assert.equal(host.status, 403);
    assert.equal(host.body.error.code, "tool_not_allowed");
    const click = await postCall(on, machine.machineId, { tool: "desktop.click", arguments: {} }, {
      authorization: `Bearer ${ada}`,
    });
    assert.equal(click.status, 200);
    assert.equal(click.body.isError, false);
    assert.equal(seen.at(-1).tool, "desktop.click");
    assert.equal(seen.at(-1).caller.verified, true);

    const stranger = await postCall(on, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
      authorization: `Bearer ${cam}`,
    });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.error.code, "not_member");
    const anonymous = await postCall(on, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
      authorization: `Bearer ${secret("pri")}`,
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, "unauthenticated");

    claims[claims.length - 1] = finishClaim(claims[claims.length - 1], "mem_ada", Date.now());
    const freed = await postCall(on, machine.machineId, { tool: "desktop.screenshot", arguments: {}, slot: "desk" }, {
      authorization: `Bearer ${bea}`,
    });
    assert.equal(freed.status, 200);
    assert.equal(freed.body.isError, false);
    assert.equal(seen.at(-1).caller.claimId, "claim_bea");
    assert.equal(seen.at(-1).caller.slot, "desk");
    assert.equal(seen.at(-1).caller.verified, true);

    const logs = await readBody(await relayFetch(on, "/admin/logs", {
      headers: { authorization: `Bearer ${on.adminToken}` },
    }));
    const written = `${lines.join("\n")}\n${JSON.stringify(logs.body)}`;
    assert.equal(written.includes(ada), false);
    assert.equal(written.includes(bea), false);
    assert.ok(logs.body.logs.some(line => line.includes("[redacted]")));
  } finally {
    console.log = original;
    await client?.close();
  }
});

test("lease tokens are checked and a room bearer is not one", async () => {
  const machine = await enrolledMachine(off);
  const metadata = await readBody(await relayFetch(off, `/.well-known/oauth-protected-resource/v0/machines/${machine.machineId}/mcp`));
  assert.equal(metadata.body.resource, `${off.origin}/v0/machines/${machine.machineId}/mcp`);
  assert.deepEqual(metadata.body.authorization_servers, [off.roomOrigin]);
  assert.deepEqual(metadata.body.bearer_methods_supported, ["header"]);

  const open = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} });
  assert.equal(open.status, 401);
  assert.equal(open.body.error.code, "lease_token_required");
  assert.match(open.headers.get("www-authenticate"), new RegExp(`/.well-known/oauth-protected-resource/v0/machines/${machine.machineId}/mcp`));
  const roomBearer = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${secret("pri")}`,
  });
  assert.equal(roomBearer.status, 401);
  assert.equal(roomBearer.body.error.code, "lease_token_rejected");

  const seen = [];
  await linkDaemon(off, machine.machineId, machine.machineToken, {
    answer(msg) { seen.push(msg); return { ok: true, result: { shot: true } }; },
  });
  const good = tokenFor(off, machine.machineId, { jti: "live-token" });
  const first = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${good}`,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.structuredContent.shot, true);
  assert.equal(seen.at(-1).caller.verified, true);
  assert.equal(seen.at(-1).caller.identityId, "mem_ada");
  assert.equal(seen.at(-1).caller.slot, "desk");
  assert.equal(Object.hasOwn(seen.at(-1), "arguments"), false);
  const replay = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${good}`,
  });
  assert.equal(replay.status, 200);

  const uncapped = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { caps: ["files"], jti: "files-only" })}`,
  });
  assert.equal(uncapped.status, 403);
  assert.equal(uncapped.body.error.code, "capability_denied");
  const scratchSlot = await postCall(off, machine.machineId, { tool: "shell.vm", arguments: {}, slot: "scratch" }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { claim: "claim_scratch", slot: "scratch", caps: ["shell.vm"], jti: "scratch-slot" })}`,
  });
  assert.equal(scratchSlot.status, 200);
  assert.equal(seen.at(-1).caller.slot, "scratch");
  assert.equal(seen.at(-1).caller.verified, true);
  const otherSlot = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {}, slot: "desk" }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { claim: "claim_other", slot: "desk", jti: "other-desk" })}`,
  });
  assert.equal(otherSlot.status, 409);
  assert.equal(otherSlot.body.error.code, "slot_held");
  assert.equal(otherSlot.body.error.slot, "desk");
  const foreignSlot = await postCall(off, machine.machineId, { tool: "shell.vm", arguments: {}, slot: "side" }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { claim: "claim_side", slot: "side", caps: ["shell.vm"], jti: "side-slot" })}`,
  });
  assert.equal(foreignSlot.status, 401);
  assert.equal(foreignSlot.body.error.code, "lease_token_rejected");
  const now = Math.floor(Date.now() / 1000);
  const expired = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { exp: now - 10, jti: "expired" })}`,
  });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, "lease_token_expired");
  const longLived = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { exp: now + 16 * 60, jti: "long" })}`,
  });
  assert.equal(longLived.status, 401);
  assert.equal(longLived.body.error.code, "lease_token_ttl");
  const wrongAud = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { aud: "relay:someone-else", jti: "aud" })}`,
  });
  assert.equal(wrongAud.status, 401);
  assert.equal(wrongAud.body.error.code, "lease_token_audience");

  const halted = await control(off, machine.machineId, "halt", {
    epoch: 1,
    resourceId: "res_desk",
    revoke: [{ jti: "revoked-jti", exp: now + 900 }],
  });
  assert.equal(halted.status, 200);
  await control(off, machine.machineId, "resume", {});
  const revoked = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { aud: "relay:res_desk", epoch: 1, jti: "revoked-jti" })}`,
  });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.error.code, "lease_token_revoked");
  const bound = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { aud: "relay:res_desk", epoch: 1, jti: "after-bind" })}`,
  });
  assert.equal(bound.status, 200);
  const stale = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { aud: "relay:res_desk", epoch: 0, jti: "stale" })}`,
  });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.error.code, "stale_epoch");
  const oldAud = await postCall(off, machine.machineId, { tool: "desktop.screenshot", arguments: {} }, {
    authorization: `Bearer ${tokenFor(off, machine.machineId, { aud: `relay:${machine.machineId}`, epoch: 1, jti: "old-aud" })}`,
  });
  assert.equal(oldAud.status, 401);
  assert.equal(oldAud.body.error.code, "lease_token_audience");
});

test("a tool call larger than 1048576 bytes is refused", async () => {
  const raw = JSON.stringify({ tool: "desktop.screenshot", arguments: { pad: "a".repeat(1_048_576) } });
  assert.ok(Buffer.byteLength(raw) > 1_048_576);
  const response = await relayFetch(off, "/v0/machines/mch_0123456789abcdef/call", { method: "POST", raw });
  const body = await readBody(response);
  assert.equal(body.status, 413);
  assert.equal(body.body.error.code, "payload_too_large");
  assert.equal(body.body.error.message, "Tool call payload exceeds 1048576 bytes");
});

async function enrolledMachine(ctx, fields = {}) {
  const minted = await mint(ctx, {
    label: fields.label ?? "Desk",
    roomId: fields.roomId ?? fields.rooms?.[0] ?? "room_alpha",
    ownerMemberId: fields.ownerMemberId ?? "mem_ada",
    inviteCode: fields.inviteCode ?? "RM-0123456789ABCDEF",
    ...(fields.displayName ? { displayName: fields.displayName } : {}),
  });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const issued = await enroll(ctx, minted.body.code);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return { ...issued.body, expiresAt: minted.body.expiresAt };
}

function tokenFor(ctx, machineId, over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return leaseToken(ctx, {
    iss: ctx.roomOrigin,
    aud: `relay:${machineId}`,
    sub: "mem_ada",
    room: "room_alpha",
    claim: "claim_ada",
    slot: "desk",
    caps: ["desktop.gui"],
    epoch: 0,
    exp: now + 60,
    jti: secret("jti"),
    ...over,
  });
}

async function until(read, timeout) {
  const start = Date.now();
  let last = null;
  for (;;) {
    last = await read();
    if (last) return last;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting; last ${JSON.stringify(last)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
