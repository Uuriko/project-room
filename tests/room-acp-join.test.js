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
  assert.equal(parseInvite(CODE).apiBase, "https://room.trydemigod.com");
  assert.throws(() => parseInvite(`http://evil.example/join/${CODE}`), /https/);
  assert.throws(() => parseInvite("https://room.trydemigod.com/r/abc"), /join/);
  assert.throws(() => parseInvite("hello"), /invite link/);
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
  const [file] = readdirSync(room.home);
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
