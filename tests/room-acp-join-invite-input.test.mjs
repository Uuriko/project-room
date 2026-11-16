// room-acp join: the invite is a single-use bearer secret and must reach the
// bridge without being typed into the command (argv is readable by other local
// users and kept in shell history). It is read from a hidden prompt, stdin, or
// ROOM_ACP_INVITE (once), and `room-acp <invite-link>` still works with a warning.
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { parseArgs, USAGE } from "../room-acp/src/args.mjs";
import { main, resolveInvite } from "../room-acp/src/cli.mjs";
import { loadConnection } from "../room-acp/src/credentials.mjs";
import { startRoom } from "./room-acp-fixture.mjs";

const run = async (argv, io = {}) => {
  const lines = [], warnings = [];
  const code = await main(argv, { print: line => lines.push(line), warn: line => warnings.push(line), ...io });
  return { code, text: lines.join("\n"), warnings: warnings.join("\n") };
};

test("args: join takes an optional room URL and never needs the invite on the command line", () => {
  assert.deepEqual([parseArgs(["join"]).command, parseArgs(["join"]).link], ["join", null]);
  assert.deepEqual([parseArgs(["join", "https://room.example"]).command, parseArgs(["join", "https://room.example"]).link], ["join", "https://room.example"]);
  assert.equal(parseArgs(["join", "https://room.example", "--no-listen", "--name", "Coder"]).noListen, true);
  assert.throws(() => parseArgs(["join", "https://room.example", "extra"]), /unexpected argument extra/);
  // The old form still parses as a join.
  const legacy = parseArgs(["https://room.example/a/RM-ABCDEFGHJKMNPQRS"]);
  assert.deepEqual([legacy.command, legacy.link], ["join", "https://room.example/a/RM-ABCDEFGHJKMNPQRS"]);
  assert.match(USAGE, /room-acp join \[<room-url>\]/);
  assert.match(USAGE, /ROOM_ACP_INVITE/);
});

test("join <room-url> reads the invite from stdin: it is in neither argv nor the printed output", async t => {
  const room = await startRoom(t);
  const { link, code: invite } = room.invite();
  const argv = ["join", room.origin, "--name", "Coder", "--no-listen"];
  const { code, text, warnings } = await run(argv, { env: { ...room.env, PATH: "" }, stdin: Readable.from([`${invite}\n`]) });
  assert.equal(code, 0, text);
  assert.match(text, /Joined room commons/);
  assert.equal(warnings, "", "no warning when the invite did not come from argv");
  for (const secret of [invite, link]) {
    assert.ok(!argv.join(" ").includes(secret), "the command text carries no invite");
    assert.ok(!text.includes(secret), "the output carries no invite");
  }
  assert.equal(loadConnection({}, room.env).roomId, "commons");
});

test("stdin may carry the full agent invite link, and only its first line is read", async t => {
  const room = await startRoom(t);
  const { link } = room.invite();
  const { code, text } = await run(["join", room.origin, "--name", "Coder", "--no-listen"], { env: { ...room.env, PATH: "" }, stdin: Readable.from([`${link}\nignored second line\n`]) });
  assert.equal(code, 0, text);
  assert.equal(loadConnection({}, room.env).roomId, "commons");
});

test("ROOM_ACP_INVITE is read once and removed from the environment the agent will inherit", async t => {
  const room = await startRoom(t);
  const { code: invite } = room.invite();
  const env = { ...room.env, PATH: "", ROOM_ACP_INVITE: invite };
  const { code, text } = await run(["join", room.origin, "--name", "Coder", "--no-listen"], { env, stdin: Readable.from([]) });
  assert.equal(code, 0, text);
  assert.equal(Object.hasOwn(env, "ROOM_ACP_INVITE"), false);
  assert.ok(!text.includes(invite));
});

test("a terminal gets a hidden prompt: the typed invite is never echoed", async t => {
  const room = await startRoom(t);
  const { code: invite } = room.invite();
  const input = new PassThrough();
  input.isTTY = true; input.setRawMode = () => input;
  const shown = [];
  const promptOutput = { write: chunk => { shown.push(String(chunk)); return true; } };
  const pending = run(["join", room.origin, "--name", "Coder", "--no-listen"], { env: { ...room.env, PATH: "" }, stdin: input, promptOutput });
  setTimeout(() => input.write(`${invite}\n`), 100);
  const { code, text } = await pending;
  assert.equal(code, 0, text);
  assert.match(shown.join(""), /Paste the invite/);
  assert.ok(!shown.join("").includes(invite), "the prompt output never contains the invite");
});

test("the legacy form still joins, and warns that the invite was on the command line", async t => {
  const room = await startRoom(t);
  const { link } = room.invite();
  const { code, text, warnings } = await run([link, "--name", "Coder", "--no-listen"], { env: { ...room.env, PATH: "" } });
  assert.equal(code, 0, text);
  assert.match(warnings, /command line/);
  assert.match(warnings, /room-acp join <room-url>/);
  assert.ok(!warnings.includes(link), "the warning does not repeat the invite");
});

test("no invite given: a clear refusal that names the safe ways, joins nothing", async t => {
  const room = await startRoom(t);
  const { code, text } = await run(["join", room.origin, "--no-listen"], { env: { ...room.env, PATH: "" }, stdin: Readable.from([""]) });
  assert.equal(code, 1);
  assert.match(text, /no invite was given/);
  assert.match(text, /ROOM_ACP_INVITE/);
  assert.equal(loadConnection({}, room.env), null);
});

test("an oversized stdin is refused", async () => {
  const env = {};
  await assert.rejects(resolveInvite({ link: "https://room.example" }, { env, io: { stdin: Readable.from(["x".repeat(5000)]) } }), /not a Room invite/);
});

test("a room URL that is not a Room address is refused before anything is read", async () => {
  await assert.rejects(resolveInvite({ link: "ftp://nope.example" }, { env: {}, io: { stdin: Readable.from(["RM-ABCDEFGHJKMNPQRS"]) } }), /Room origin must use https|invalid Room origin/);
});
