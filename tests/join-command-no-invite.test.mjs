// The documented room-acp join commands must not put the bearer invite in argv
// (visible in the process list, kept in shell history): they name the Room and
// let room-acp ask for the invite. Pins the three docs that give the command.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["docs/CONNECT-AGENT-QUICKSTART.md", "docs/agents/codex.md", "docs/agents/claude-code.md", "docs/JOINING.md", "docs/AGENT-START-HERE.md", "AGENTS.md"];
const INVITE_TEXT = /<\s*invite[\w -]*>|invite[_-]?(url|link)|\/(?:join|a)\/|\bRM-[A-Z0-9]{6,}/i;

// Shell commands only: fenced lines and inline code spans that run room-acp.
function commands(text) {
  const found = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) { fenced = !fenced; continue; }
    if (fenced) { if (/room-acp/.test(line) && /\b(npx|node|room-acp)\b/.test(line)) found.push(line.trim()); continue; }
    for (const [, span] of line.matchAll(/`([^`]+)`/g)) if (/(npx|node) .*room-acp|^room-acp /.test(span)) found.push(span);
  }
  return found;
}

test("no documented room-acp command carries an invite", () => {
  let joinCommands = 0;
  for (const file of DOCS) {
    for (const command of commands(readFileSync(join(ROOT, file), "utf8"))) {
      assert.ok(!INVITE_TEXT.test(command), `${file}: command carries an invite: ${command}`);
      if (/room-acp(?:\.tgz)? join\b/.test(command) || /room-acp\/src\/cli\.mjs join\b/.test(command)) joinCommands++;
    }
  }
  assert.ok(joinCommands >= 3, "the quickstart, Codex and Claude Code docs each show the join form");
});

test("the quickstart tells the reader the invite is a sensitive single-use secret and how to hand it over", () => {
  const text = readFileSync(join(ROOT, "docs/CONNECT-AGENT-QUICKSTART.md"), "utf8");
  assert.match(text, /single-use bearer secret/);
  assert.match(text, /hidden prompt/);
  assert.match(text, /shell keeps\s+it in history/);
});

test("the checker catches a command with the invite in it", () => {
  assert.equal(commands("```sh\nnpx -y room-acp 'https://room.example/a/RM-ABCDEFGHJKMNPQRS'\n```").filter(c => INVITE_TEXT.test(c)).length, 1);
  assert.equal(commands("Run `npx room-acp join <ROOM_URL>` now.").filter(c => INVITE_TEXT.test(c)).length, 0);
  assert.equal(commands("Run `npx room-acp '<INVITE_URL>'` now.").filter(c => INVITE_TEXT.test(c)).length, 1);
});
