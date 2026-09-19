import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  AGENT_TYPE_CATALOG, ROOM_ROSTER, JOIN_PATHS, JOIN_PATH_ANCHORS,
  catalogById, catalogSelection, catalogJoinAnchor, catalogDoorHtml,
  isCatalogAgentType, rosterSelection, routeFromDisplayName
} from "../src/room-roster.js";
import { publicRoomDoorHtml } from "../deploy/room-entry.mjs";

const checkout = fileURLToPath(new URL("..", import.meta.url));

test("first-party catalog lists harness types with icon, best-for, and one existing join path", () => {
  assert.deepEqual(AGENT_TYPE_CATALOG.map(row => row.id), [
    "claude-code", "codex", "cursor", "hermes", "opencode", "pi",
    "grok-bot", "grok-build", "instinct", "muse"
  ]);
  assert.deepEqual([...JOIN_PATHS], ["packet", "paste-prompt", "invite-code", "mcp-url"]);
  for (const row of AGENT_TYPE_CATALOG) {
    assert.match(row.label, /\S/);
    assert.match(row.icon, /\S/);
    assert.match(row.bestFor, /\S/);
    assert.equal(JOIN_PATHS.includes(row.joinPath), true, row.id);
    assert.equal(["packet", "mcp", "direct"].includes(row.route), true, row.id);
    assert.equal(["chat", "contribute", "review"].includes(row.access), true, row.id);
    assert.doesNotMatch(JSON.stringify(row), /marketplace|ROOM_AGENT_TOKEN|gWi-|pricing/i);
  }
  assert.equal(isCatalogAgentType("claude-code"), true);
  assert.equal(isCatalogAgentType("unknown"), false);
  assert.equal(catalogById("missing"), null);
});

test("catalog click fills the same Connect join path as the named roster", () => {
  assert.equal(catalogSelection("muse").name, "Muse");
  assert.equal(catalogSelection("muse").route, "packet");
  assert.equal(catalogSelection("muse").access, "chat");
  assert.equal(catalogSelection("muse").joinPath, "paste-prompt");
  assert.equal(catalogSelection("muse").agentType, "muse");
  assert.match(catalogSelection("muse").hint, /has not contributed/);
  const museRoster = rosterSelection("muse");
  const museCatalog = catalogSelection("muse");
  assert.equal(museCatalog.name, museRoster.name);
  assert.equal(museCatalog.access, museRoster.access);
  assert.equal(museCatalog.route, museRoster.route);
  assert.equal(museCatalog.hint, museRoster.hint);
  assert.equal(catalogSelection("grok-build").route, "mcp");
  assert.equal(catalogSelection("grok-bot").route, "direct");
  assert.equal(catalogSelection("claude-code").name, "Claude Code");
  assert.equal(catalogSelection("claude-code").route, "mcp");
  assert.equal(catalogSelection("claude-code").joinPath, "mcp-url");
  assert.equal(catalogSelection("cursor").joinPath, "paste-prompt");
  assert.equal(catalogSelection("pi").joinPath, "invite-code");
  assert.equal(catalogSelection("unknown"), null);
  assert.equal(routeFromDisplayName("Claude Code"), "mcp");
  assert.equal(routeFromDisplayName("Pi"), "mcp");
});

test("catalog door cards reuse existing Join anchors and stay off a public store", () => {
  assert.equal(catalogJoinAnchor("mcp-url"), "#mcp-join");
  assert.equal(catalogJoinAnchor("paste-prompt"), "#join-agent");
  assert.equal(catalogJoinAnchor("packet"), "#join-agent");
  assert.equal(catalogJoinAnchor("invite-code"), "#join-code");
  assert.equal(JOIN_PATH_ANCHORS["mcp-url"], "#mcp-join");
  const html = catalogDoorHtml();
  assert.match(html, /id="agent-type-catalog"/);
  assert.match(html, /Types for this Room only/);
  assert.match(html, /Not a public agent store/);
  assert.doesNotMatch(html, /marketplace|pricing|per month|buy/i);
  for (const row of AGENT_TYPE_CATALOG) {
    assert.match(html, new RegExp(`data-agent-type="${row.id}"`));
    assert.match(html, new RegExp(`data-join-path="${row.joinPath}"`));
    assert.match(html, new RegExp(`href="${catalogJoinAnchor(row.joinPath)}"`));
    assert.match(html, new RegExp(row.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(row.bestFor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const door = publicRoomDoorHtml();
  assert.match(door, /id="agent-type-catalog"/);
  assert.match(door, /data-agent-type="claude-code"/);
  assert.match(door, /href="#mcp-join"/);
  assert.doesNotMatch(door, /marketplace/i);
});

test("Add agent markup renders the catalog with roster aliases on the four named assistants", () => {
  const html = readFileSync(join(checkout, "index.html"), "utf8");
  assert.match(html, /id="agent-type-catalog"/);
  assert.match(html, /Types for this Room only/);
  assert.match(html, /same join path/);
  assert.doesNotMatch(html, /marketplace/i);
  for (const id of AGENT_TYPE_CATALOG.map(row => row.id)) {
    assert.match(html, new RegExp(`data-agent-type="${id}"`));
  }
  for (const id of ROOM_ROSTER.map(row => row.id)) {
    assert.match(html, new RegExp(`data-roster="${id}"`));
  }
  assert.match(html, /Best for local coding sessions with MCP tools/);
  const css = readFileSync(join(checkout, "src/styles.css"), "utf8");
  assert.match(css, /\.agent-type-catalog/);
  assert.match(css, /\.agent-type-card/);
  assert.match(css, /\.agent-roster \.button \{ width: auto; min-height: 44px;/);
});
