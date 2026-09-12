import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  ROOM_ROSTER, rosterById, rosterSelection, suggestedConfigDir, rosterNameTaken,
  grokBuildToml, mcpJson, importCommand, roomRosterMain, capabilitySummary,
  setupChecklist, routeHint, placeholderSnippetPaths, routeFromDisplayName,
  claudeMcpAddCommand, reconnectCopy
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
});

test("connect recipes name packet, MCP and Node routes without tokens", () => {
  assert.match(capabilitySummary("chat")[1], /does not start a model/);
  assert.equal(capabilitySummary("contribute").some(line => /work drafts/.test(line)), true);
  assert.equal(capabilitySummary("review").some(line => /Review work/.test(line)), true);
  assert.match(setupChecklist({ route: "mcp" }).join("\n"), /room_check_access/);
  assert.match(setupChecklist({ route: "packet" }).join("\n"), /Use my AI/);
  assert.match(setupChecklist({ route: "direct" }).join("\n"), /On that computer/);
  assert.match(routeHint("packet"), /optional identity/i);
  const paths = placeholderSnippetPaths("/absolute/private/room-agent-grok-build");
  assert.equal(JSON.parse(mcpJson(paths)).mcpServers["project-room"].env.ROOM_AGENT_CONFIG, paths.configDir);
  assert.equal(mcpJson(paths).includes("TOKEN"), false);
  assert.equal(grokBuildToml(paths).includes("TOKEN"), false);
  assert.throws(() => grokBuildToml({ nodePath: "/n", adapterPath: "/a", configDir: "/Users/x/.grok/config.toml" }), /Grok config/);
  assert.throws(() => grokBuildToml({ nodePath: "/n", adapterPath: "/a", configDir: "/tmp/token-secret" }), /secrets/);
  assert.match(importCommand(paths.configDir), /pbpaste \| node scripts\/agent-inbox.mjs import '\/absolute\/private\/room-agent-grok-build'/);
});

test("reconnect copy is secret-free and names the host snippets", () => {
  assert.equal(routeFromDisplayName("Instinct"), "packet");
  assert.equal(routeFromDisplayName("Grok Build"), "mcp");
  assert.equal(routeFromDisplayName("Grok Bot"), "direct");
  assert.equal(routeFromDisplayName("Custom bot"), "mcp");
  const copy = reconnectCopy({ displayName: "Grok Build" });
  assert.match(copy, /No private key/);
  assert.match(copy, /mcpServers/);
  assert.match(copy, /claude mcp add/);
  assert.equal(/token/i.test(copy), false);
  assert.match(claudeMcpAddCommand(placeholderSnippetPaths()), /claude mcp add --transport stdio/);
  assert.match(reconnectCopy({ displayName: "Muse" }), /Use my AI/);
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
  assert.match(html, /id="agent-connect-route"/);
  assert.match(html, /id="agent-host-snippets"/);
  assert.match(html, /id="agent-capabilities"/);
  assert.match(html, /Chat packet — no Room key/);
  assert.match(html, /id="agent-copy-checklist"/);
  assert.match(html, /id="agent-key-later"/);
  assert.match(html, /id="agent-connect-more"/);
  assert.doesNotMatch(html, /id="agent-copy-json"/);
  assert.match(html, /id="agent-import-checklist"/);
  const css = readFileSync(join(checkout, "src/styles.css"), "utf8");
  assert.match(css, /--room-paper/);
  assert.match(css, /--room-ink/);
  assert.match(css, /--room-quiet/);
  assert.match(css, /--room-rule/);
  assert.match(css, /\.member-status/);
  assert.match(css, /\.done-chip/);
  assert.match(css, /\.presence-dot/);
  assert.match(css, /\.member-handle-agent/);
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
  assert.match(app, /member-status/);
  assert.match(app, /done-chip/);
  assert.match(app, /member-handle-agent/);
  assert.match(app, /messageCluster/);
  assert.match(app, /mentionHtml/);
  assert.match(html, /id="agent-connect-title">Add agent</);
  assert.match(app, /syncComposerChrome/);
  assert.match(app, /dismissRoomGuide/);
  assert.match(app, /escapeChatAction, messageCluster/);
  assert.match(app, /kindLabel, memberStatus, memberHandle, memberPresence, memberDoneChip, presenceLabel, addressMember, shouldAddressPresenceClick, messageMentionsMember, replyAuthorToAddress, composerPlaceholder, removeMention, parseSearchQuery, reactionPills/);
  assert.match(app, /replyAuthorToAddress/);
  assert.match(app, /shouldAddressPresenceClick\(e\.target\)/);
  assert.match(app, /grouped-time/);
  assert.match(app, /messageMentionsMember/);
  assert.match(app, /data-mention-id/);
  assert.doesNotMatch(app, /\$\("#presence-list"\)\.addEventListener\("click", e => \{\s*if \(e\.target\.closest\("details, summary, button, a"\)\) return;/);
  assert.match(app, /author\.kind === "agent"/);
  assert.match(app, /Address \$\{m\.displayName\} in chat/);
  assert.doesNotMatch(app, /maybeOpenCatchUp/);
  assert.doesNotMatch(app, /"Message…"/);
  assert.match(app, /composerPlaceholder/);
  assert.match(app, /removeMention/);
  assert.match(html, /id="reply-mention"/);
  assert.match(html, /Also @/);
  assert.match(html, /id="search-mentions"/);
  assert.match(html, />Mentioned you</);
  assert.match(app, /parseSearchQuery/);
  assert.match(app, /mentionsFilterOn/);
  assert.match(app, /reactionPills/);
  assert.doesNotMatch(app, /details class="reactions"/);
  assert.doesNotMatch(app, /reaction-menu/);
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
  assert.match(source, /function describeRoute/);
  assert.match(source, /setupChecklist/);
  assert.match(source, /reconnectCopy/);
  assert.match(source, /Copy plug-in steps/);
  assert.match(app, /aria-label.*Open /);
  const css = readFileSync(join(checkout, "src/styles.css"), "utf8");
  assert.match(css, /\.agent-roster \.button \{ width: auto; min-height: 44px;/);
  assert.match(css, /\.composer-toolbar select \{[^}]*min-height: 44px/);
  assert.match(css, /\.room-navigation \{ position: sticky;/);
  assert.match(css, /#account-rooms-list \.inbox-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /#agent-import-checklist/);
  assert.doesNotMatch(readFileSync(join(checkout, "docs/ROOM-ROSTER.md"), "utf8"), /member key cannot/i);
});
