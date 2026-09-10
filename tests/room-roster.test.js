import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  ROOM_ROSTER, rosterById, rosterSelection, suggestedConfigDir, rosterNameTaken,
  grokBuildToml, mcpJson, importCommand, roomRosterMain
} from "../src/room-roster.js";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const runner = join(checkout, "scripts/room-roster.mjs");
const options = { execPath: process.execPath, checkout };

test("roster is exactly Instinct, Muse, Grok Build and Grok Bot with safe routes", () => {
  assert.deepEqual(ROOM_ROSTER.map(row => row.id), ["instinct", "muse", "grok-build", "grok-bot"]);
  assert.equal(rosterById("muse").product, "Meta Muse personal AI agent");
  assert.equal(rosterById("muse").contributed, false);
  assert.equal(rosterById("muse").route, "packet");
  assert.equal(rosterById("instinct").route, "packet");
  assert.equal(rosterById("grok-build").route, "mcp");
  assert.equal(rosterById("grok-bot").route, "direct");
  assert.equal(rosterSelection("muse").access, "chat");
  assert.equal(rosterSelection("instinct").access, "review");
  assert.equal(rosterSelection("grok-build").name, "Grok Build");
  assert.equal(rosterSelection("unknown"), null);
  for (const row of ROOM_ROSTER) {
    assert.match(row.today, /No Room key|import the private setup|Bot runtime/i);
    assert.equal(row.today.includes("gWi-"), false);
    assert.doesNotMatch(JSON.stringify(row), /ROOM_AGENT_TOKEN|owner-key/);
  }
});

test("MCP snippets require absolute private paths and never mention tokens", () => {
  const configDir = "/absolute/private/room-agent-grok-build";
  const toml = grokBuildToml({
    nodePath: process.execPath,
    adapterPath: join(checkout, "scripts/agent-mcp.mjs"),
    configDir
  });
  assert.match(toml, /\[mcp_servers\.project-room\]/);
  assert.match(toml, /ROOM_AGENT_CONFIG = "\/absolute\/private\/room-agent-grok-build"/);
  assert.equal(toml.includes("TOKEN"), false);
  assert.equal(JSON.parse(mcpJson({
    nodePath: process.execPath,
    adapterPath: join(checkout, "scripts/agent-mcp.mjs"),
    configDir
  })).mcpServers["project-room"].env.ROOM_AGENT_CONFIG, configDir);
  assert.throws(() => grokBuildToml({ nodePath: "node", adapterPath: "/a", configDir }), /absolute/);
  assert.throws(() => grokBuildToml({ nodePath: "/n", adapterPath: "/a", configDir: "/Users/x/.grok/config.toml" }), /Grok config/);
  assert.throws(() => grokBuildToml({ nodePath: "/n", adapterPath: "/a", configDir: "/tmp/token-secret" }), /secrets/);
  assert.doesNotThrow(() => grokBuildToml({
    nodePath: "/opt/secret-bin/node", adapterPath: "/opt/adapter/agent-mcp.mjs", configDir
  }));
  assert.match(importCommand(configDir), /pbpaste \| node scripts\/agent-inbox.mjs import '\/absolute\/private\/room-agent-grok-build'/);
});

test("CLI prints Muse packet route and refuses to write host config", () => {
  const all = roomRosterMain([], options);
  assert.match(all, /Muse/);
  assert.match(all, /Instinct/);
  assert.match(all, /Grok Build/);
  assert.match(all, /Grok Bot/);
  assert.match(all, /bound account/);
  assert.doesNotMatch(all, /member key cannot/i);
  const help = roomRosterMain(["--help"], options);
  assert.match(help, /member key or account key/);
  assert.doesNotMatch(help, /not a member key/);
  const muse = roomRosterMain(["muse"], options);
  assert.match(muse, /Muse app or WhatsApp/);
  assert.match(muse, /has not contributed/);
  assert.match(muse, /Use my AI/);
  assert.doesNotMatch(muse, /\[mcp_servers/);
  const grok = roomRosterMain(["grok-build", "--snippet"], options);
  assert.match(grok, /mcp_servers\.project-room/);
  assert.match(grok, /scripts\/agent-mcp\.mjs/);
  assert.equal(grok.includes("TOKEN"), false);
  assert.throws(() => roomRosterMain(["--write"], options), /refuses to write/);
  assert.throws(() => roomRosterMain(["--apply", "/tmp/config.toml"], options), /refuses to write/);
  assert.throws(() => roomRosterMain(["claude"], options), /unknown roster id/);
  const parsed = JSON.parse(roomRosterMain(["--json"], options));
  assert.equal(parsed.length, 4);
  assert.equal(parsed.find(row => row.id === "muse").contributed, false);
  assert.equal(parsed.find(row => row.id === "grok-build").grokToml.includes("ROOM_AGENT_TOKEN"), false);
});

test("script spawn matches the module and rejects write flags", () => {
  const listed = spawnSync(process.execPath, [runner], { encoding: "utf8", timeout: 5000 });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Named assistants|Instinct/);
  const write = spawnSync(process.execPath, [runner, "--write"], { encoding: "utf8", timeout: 5000 });
  assert.equal(write.status, 1);
  assert.match(write.stderr, /refuses to write/);
  assert.equal(write.stdout, "");
});

test("roster name collision is case-insensitive and ignores inactive or human members", () => {
  const members = {
    "agent-1": { kind: "agent", active: true, displayName: "Instinct" },
    "agent-2": { kind: "agent", active: false, displayName: "Muse" },
    potter: { kind: "human", active: true, displayName: "Grok Build" }
  };
  assert.equal(rosterNameTaken(members, "instinct"), true);
  assert.equal(rosterNameTaken(members, " Muse "), false);
  assert.equal(rosterNameTaken(members, "Grok Build"), false);
  assert.equal(rosterNameTaken(members, "Grok Bot"), false);
  assert.equal(rosterNameTaken(null, "Instinct"), false);
});

test("Add agent markup lists the four roster names", () => {
  const html = readFileSync(join(checkout, "index.html"), "utf8");
  for (const id of ["instinct", "muse", "grok-build", "grok-bot"]) {
    assert.match(html, new RegExp(`data-roster="${id}"`));
  }
  assert.match(html, /Muse app or WhatsApp/);
  assert.match(html, /id="agent-access-hint"/);
  assert.match(html, /id="inbox-heading"/);
  assert.match(html, /id="auth-kind-room"/);
  assert.match(html, /id="access-key-reveal"/);
  assert.match(html, /id="invite-link"/);
  assert.match(html, /Paste your key/);
  assert.match(html, /id="room-guide"/);
  assert.match(html, /Inbox uses <strong>Account key<\/strong>/);
  assert.match(html, /id="people-hint"/);
  assert.match(html, /Write to the room/);
  assert.match(html, /id="auth-guest-note"/);
  assert.match(html, /eight hours in that browser/);
  assert.match(html, /id="share-link-intro"/);
  assert.match(html, /Send this link to a person/);
  assert.match(html, /data-room-section="people"/);
  assert.match(html, /id="agent-import-checklist"/);
  assert.match(html, /pbpaste \| node scripts\/agent-inbox\.mjs import/);
  const app = readFileSync(join(checkout, "src/app.js"), "utf8");
  assert.match(app, /How to invite someone/);
  assert.match(app, /How to add an agent/);
  assert.match(app, /How to open Inbox/);
  assert.match(app, /Open this room/);
  assert.match(app, /data-empty-write/);
  assert.match(app, /data-empty-work/);
  assert.match(app, /Completed results appear here after work is finished/);
  assert.match(html, /This is the chat/);
  assert.match(html, /@ to address someone/);
  assert.match(html, /id="mention-list"/);
  assert.match(html, />Add agent</);
  assert.match(app, /data-empty-invite/);
  assert.match(app, /presence-heading/);
  assert.match(app, /messageCluster/);
  assert.match(app, /mentionHtml/);
  assert.match(html, /id="agent-connect-title">Add agent</);
  assert.match(app, /Agents join this chat as named people/);
  assert.match(app, /kindLabel, memberStatus, addressMember/);
  assert.match(app, /author\.kind === "agent"/);
  assert.match(app, /Address \$\{m\.displayName\} in chat/);
  assert.doesNotMatch(app, /maybeOpenCatchUp/);
  assert.match(html, /id="people-panel"/);
  assert.match(html, /id="connect-agent-button"/);
  assert.match(html, /id="message-input"/);
  assert.match(html, /id="message-list"/);
  const source = readFileSync(join(checkout, "src/agent-connections.js"), "utf8");
  assert.match(source, /rosterSelection/);
  assert.match(source, /rosterNameTaken/);
  assert.match(source, /from "\.\/room-roster\.js"/);
  assert.match(source, /\$\{label\} for \$\{row\.displayName\}/);
  assert.match(source, /function describeImport/);
  assert.match(app, /aria-label.*Open /);
  const css = readFileSync(join(checkout, "src/styles.css"), "utf8");
  assert.match(css, /\.agent-roster \.button \{ width: auto; min-height: 44px;/);
  assert.match(css, /\.composer-toolbar select \{[^}]*min-height: 44px/);
  assert.match(css, /\.room-navigation \{ position: sticky;/);
  assert.match(css, /#account-rooms-list \.inbox-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /#agent-import-checklist/);
  assert.doesNotMatch(readFileSync(join(checkout, "docs/ROOM-ROSTER.md"), "utf8"), /member key cannot/i);
});
