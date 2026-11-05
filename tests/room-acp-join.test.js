// room-acp B2: invite link parsing, join against a real local Room server,
// private credential storage, and redaction of every secret.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseInvite } from "../room-acp/src/link.mjs";
import { redact, registerSecret } from "../room-acp/src/redact.mjs";
import { main } from "../room-acp/src/cli.mjs";
import { loadConnection } from "../room-acp/src/credentials.mjs";
import { startRoom } from "./room-acp-fixture.mjs";

const CODE = "RM-ABCDEFGHJKMNPQRS";

test("parseInvite: hosted link, /room prefix, bare code, and refusals", () => {
  assert.deepEqual(parseInvite(`https://room.trydemigod.com/join/${CODE}`), { apiBase: "https://room.trydemigod.com", code: CODE });
  assert.deepEqual(parseInvite(`https://getdasha.com/room/join/${CODE.toLowerCase()}`), { apiBase: "https://getdasha.com/room", code: CODE });
  assert.deepEqual(parseInvite(`https://www.getdasha.com/room/join/${CODE}`), { apiBase: "https://www.getdasha.com/room", code: CODE });
  assert.equal(parseInvite(CODE).apiBase, "https://room.trydemigod.com");
  assert.throws(() => parseInvite(`http://evil.example/join/${CODE}`), /https/);
  assert.throws(() => parseInvite("https://room.trydemigod.com/r/abc"), /join/);
  assert.throws(() => parseInvite("hello"), /invite link/);
});

test("parseInvite: a link naming any non-issuer origin is refused (RES-0129)", () => {
  const token = "A".repeat(43);
  for (const link of [
    `https://evil.example.com/join/${CODE}`, // arbitrary origin
    `https://room.trydemigod.com@evil.example.com/join/${CODE}`, // userinfo: real host is the username
    `https://room.trydemigod.com.evil.example.com/join/${CODE}`, // lookalike host
    `https://room.trydemigod.com:8443/join/${CODE}`, // non-default port
    `https://room.trydemigod.com/some/prefix/join/${CODE}`, // path prefix on the real host
    `https://evil.example.com/steal/join/${CODE}`, // prefix + foreign origin
    `https://evil.example.com/room/abc#join/${token}`, // share-link form, foreign origin
    `https://room.trydemigod.com/deep/path#join/${token}`, // share-link form, deep path
  ]) assert.throws(() => parseInvite(link), /not a Room address|credentials in the URL/, link);
  // Controls: the legitimate share-link forms of both doors still parse.
  assert.deepEqual(parseInvite(`https://room.trydemigod.com/#join/${token}`), { apiBase: "https://room.trydemigod.com", linkToken: token });
  assert.deepEqual(parseInvite(`https://www.getdasha.com/room/#join/${token}`), { apiBase: "https://www.getdasha.com/room", linkToken: token });
  // Loopback stays usable for local development and the test server.
  assert.equal(parseInvite(`http://127.0.0.1:49152/join/${CODE}`).apiBase, "http://127.0.0.1:49152");
  // An operator-configured deployment is trusted exactly, and only exactly.
  assert.equal(parseInvite(`https://rooms.example.net/join/${CODE}`, { origin: "https://rooms.example.net" }).apiBase, "https://rooms.example.net");
  assert.equal(parseInvite(CODE, { origin: "https://www.getdasha.com/room" }).apiBase, "https://www.getdasha.com/room");
  assert.throws(() => parseInvite(`https://rooms.example.net/join/${CODE}`, { origin: "https://other.example.net" }), /not a Room address/);
});

test("parseInvite: the /a/<code> agent-steps link parses like /join/ under the same issuer policy", () => {
  assert.deepEqual(parseInvite(`https://room.trydemigod.com/a/${CODE}`), { apiBase: "https://room.trydemigod.com", code: CODE });
  assert.deepEqual(parseInvite(`https://www.getdasha.com/room/a/${CODE.toLowerCase()}/`), { apiBase: "https://www.getdasha.com/room", code: CODE });
  assert.deepEqual(parseInvite(`https://room.trydemigod.com/a/${CODE}?ref=share`), { apiBase: "https://room.trydemigod.com", code: CODE });
  assert.equal(parseInvite(`http://127.0.0.1:49152/a/${CODE}`).apiBase, "http://127.0.0.1:49152");
  assert.equal(parseInvite(`https://rooms.example.net/a/${CODE}`, { origin: "https://rooms.example.net" }).apiBase, "https://rooms.example.net");
  for (const link of [`https://evil.example.com/a/${CODE}`, `https://room.trydemigod.com.evil.example/a/${CODE}`,
    `https://user:pw@room.trydemigod.com/a/${CODE}`, `http://room.trydemigod.com/a/${CODE}`])
    assert.throws(() => parseInvite(link), /not a Room address|credentials in the URL|https/, link);
  assert.throws(() => parseInvite(`https://room.trydemigod.com/a/${CODE}/extra`), /join/);
  assert.throws(() => parseInvite(`https://room.trydemigod.com/ab/${CODE}`), /join/);
  // Code links carry only the share-analytics ?ref=; any other query or a fragment is refused.
  for (const path of ["a", "join"]) for (const suffix of ["?token=x", "?ref=a&token=x", "#x", "?ref=a#frag"])
    assert.throws(() => parseInvite(`https://room.trydemigod.com/${path}/${CODE}${suffix}`), /query|fragment/, `${path}${suffix}`);
});

test("redact hides credentials, codes and registered secrets", () => {
  registerSecret("s3cret-value-123");
  const out = redact(`rak_abcdefgh123 pri_zzzzzzzz9 ${CODE} Authorization: Bearer xyz s3cret-value-123`);
  for (const leaked of ["rak_abcdefgh123", "pri_zzzzzzzz9", CODE, "xyz", "s3cret-value-123"]) assert.ok(!out.includes(leaked), leaked);
});

test("join redeems the link, saves 0600, and never prints the credential", async t => {
  const room = await startRoom(t);
  const { link, code } = room.invite();
  const lines = [];
  const code1 = await main([link, "--name", "Coder"], { print: line => lines.push(line), env: room.env, joinOnly: true });
  assert.equal(code1, 0, lines.join("\n"));
  const saved = loadConnection({}, room.env);
  assert.equal(saved.roomId, "commons");
  assert.equal(saved.displayName, "Coder");
  assert.match(saved.credential, /^rak_/);
  assert.match(saved.hostId, /^room-acp-/);
  const file = readdirSync(room.home).find(name => name.endsWith(".json"));
  if (process.platform !== "win32") {
    assert.equal(statSync(join(room.home, file)).mode & 0o777, 0o600);
    assert.equal(statSync(room.home).mode & 0o777, 0o700);
  }
  assert.ok(readFileSync(join(room.home, file), "utf8").includes(saved.credential));
  lines.length = 0;
  assert.equal(await main(["status"], { print: line => lines.push(line), env: room.env }), 0);
  const printed = lines.join("\n");
  assert.match(printed, /"credential": "saved"/);
  for (const secret of [saved.credential, saved.identitySecret, code].filter(Boolean)) assert.ok(!printed.includes(secret));
  // A reused one-time code fails cleanly with the code redacted.
  lines.length = 0;
  assert.equal(await main([link], { print: line => lines.push(line), env: room.env, joinOnly: true }), 1);
  assert.ok(!lines.join("\n").includes(code));
  assert.equal(await main(["logout"], { print: () => {}, env: room.env }), 0);
  assert.equal(loadConnection({}, room.env), null);
});

test("the invite.url the server emits joins through room-acp unchanged", async t => {
  const room = await startRoom(t);
  // Contract: the real agent-invite create endpoint's url, not a handcrafted /join link.
  const response = await fetch(`${room.origin}/api/rooms/commons/agent-invites`, { method: "POST",
    headers: { Authorization: `Bearer ${room.ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ profile: "contribute", displayName: "Coder" }) });
  assert.equal(response.status, 201);
  const invite = await response.json();
  assert.equal(new URL(invite.url).pathname, `/a/${encodeURIComponent(invite.code)}`);
  assert.deepEqual(parseInvite(invite.url), { apiBase: room.origin, code: invite.code });
  const lines = [];
  assert.equal(await main([invite.url, "--name", "Coder"], { print: line => lines.push(line), env: room.env, joinOnly: true }), 0, lines.join("\n"));
  const saved = loadConnection({}, room.env);
  assert.equal(saved.roomId, "commons");
  assert.match(saved.credential, /^rak_/);
  for (const secret of [saved.credential, invite.code]) assert.ok(!lines.join("\n").includes(secret));
});
