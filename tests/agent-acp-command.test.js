// D12: the landing's static #agent-acp-command block must print the canonical
// room-acp command. The generated surfaces (roomAcpCommand) have always had
// the --allow-remote=root flag; the static block drifted from them because no
// test covered it. On npm 12 the flagless form is refused with EALLOWREMOTE
// before the package is fetched. See room-acp/README.md for the canonical form.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { roomAcpCommand } from "../src/agent-invite-ui.js";
import { llmsTxt, llmsFullTxt, skillMd } from "../server/agent-discovery.mjs";

const CANONICAL = "npx -y --allow-remote=root --package=https://room.trydemigod.com/room-acp.tgz room-acp '<INVITE_URL>' --name 'My agent'";

const decode = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

test("static landing #agent-acp-command prints the canonical room-acp command", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(/<code id="agent-acp-command">([^<]*)<\/code>/);
  assert.ok(match, "index.html carries a static #agent-acp-command block");
  assert.equal(decode(match[1]), CANONICAL);
});

test("static landing command matches the generated roomAcpCommand output", () => {
  const generated = roomAcpCommand("<INVITE_URL>", "My agent", new URL("https://room.trydemigod.com/"));
  assert.equal(generated, CANONICAL);
});

// T-04 (wave-3400): the canonical generic form must appear verbatim on every
// generated joining surface, the full packet must teach it before the
// resumable agent-inbox alternative, and the /skill.md vs /SKILL.md paths
// must disambiguate each other. The Claude Code host page must not recommend
// a repo checkout again.
const GENERIC = "npx -y --allow-remote=root --package=https://room.trydemigod.com/room-acp.tgz room-acp \"<invite link>\"";

test("canonical room-acp command appears verbatim in llms.txt, llms-full.txt and SKILL.md", () => {
  for (const [name, text] of [["llms.txt", llmsTxt()], ["llms-full.txt", llmsFullTxt()], ["SKILL.md", skillMd()]]) {
    assert.ok(text.includes(GENERIC), `${name} carries the canonical room-acp command`);
  }
  const full = llmsFullTxt();
  assert.ok(full.indexOf(GENERIC) < full.indexOf("agent-inbox.mjs join"), "llms-full teaches the canonical command before the resumable CLI alternative");
});

test("skill paths disambiguate each other (R-13)", () => {
  assert.ok(llmsTxt().includes("/SKILL.md (uppercase; /skill.md is this packet)"), "short packet (and lowercase /skill.md, same bytes) names the uppercase skill");
  assert.ok(skillMd().includes("`/skill.md` (lowercase) serves only the short packet"), "SKILL.md names the lowercase packet");
});

test("docs surfaces carry the canonical command and claude-code drops the checkout path", () => {
  const claude = readFileSync(new URL("../docs/agents/claude-code.md", import.meta.url), "utf8");
  assert.ok(claude.includes("npx -y --allow-remote=root --package=https://room.trydemigod.com/room-acp.tgz room-acp \"<invite-link>\" --agent claude"), "claude-code carries the canonical command with its --agent tail");
  assert.ok(!claude.includes("room-acp/src/cli.mjs"), "claude-code no longer serves the checkout path");
  assert.ok(!claude.includes("will work once the package is published"), "claude-code no longer calls the package unpublished");
  assert.ok(!claude.includes("checkout of this repo"), "claude-code no longer recommends a checkout");
  for (const page of ["index.md", "paste.md"]) {
    const doc = readFileSync(new URL(`../docs/agents/${page}`, import.meta.url), "utf8");
    assert.ok(doc.includes(GENERIC), `docs/agents/${page} carries the canonical room-acp command`);
  }
  const setup = readFileSync(new URL("../skills/project-room-setup/SKILL.md", import.meta.url), "utf8");
  assert.ok(setup.includes(GENERIC), "setup skill carries the canonical room-acp command");
});
