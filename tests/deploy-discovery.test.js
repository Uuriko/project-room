// Deploy-aware discovery (#601): build-time capability inventory, card
// deployed block, and llms deployed-rev line.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { buildCapabilities, pluginRoutes, renderCapabilitiesModule, FAMILIES, inventoryRoutes } from "../scripts/build-capabilities.mjs";
import { agentCard, agentCardJson, llmsTxt, llmsFullTxt, deployedInfo, pushNotificationsSupported } from "../deploy/agent-discovery.mjs";
import { CAPABILITIES } from "../deploy/capabilities.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAMILY_NAMES = FAMILIES.map(([name]) => name);

test("generator maps fixture routes to family booleans", () => {
  const map = buildCapabilities([
    "/api/agent-identities",
    "/api/identity-create",
    "/api/rooms/{id}/collab/notes",
    "/api/inbox/webhooks/{connectionId}",
  ]);
  assert.equal(map["agent-identities"], true);
  assert.equal(map["collab"], true);
  assert.equal(map["webhooks"], true);
  assert.equal(map["agent-keys"], false);
  assert.equal(map["spend-allowance"], false);
});

test("removing a family's routes flips its flag to false", () => {
  const full = buildCapabilities(["/api/agent-keys", "/api/agent-keys/{id}/rotate", "/api/version"]);
  assert.equal(full["agent-keys"], true);
  const pruned = buildCapabilities(["/api/version"]);
  assert.equal(pruned["agent-keys"], false);
  // Families are independent: pruning one leaves others intact.
  assert.deepEqual(Object.keys(pruned), Object.keys(full));
});

test("plugin route extraction finds anchored regex prefixes and descriptors", () => {
  const src = [
    'const KEY_ACTION_ROUTE = /^\\/api\\/agent-keys\\/(rak_[A-Za-z0-9_-]{1,64})\\/(rotate|revoke)$/;',
    'const SUBSCRIPTION_ROUTE = /^\\/api\\/agent-webhooks\\/([A-Za-z0-9_-]{1,64})$/;',
    'Object.freeze({ action: "read-manifest", method: "GET", path: "/api/agent-manifest", requiredScope: null, }),',
  ].join("\n");
  const routes = pluginRoutes(src);
  assert.ok(routes.includes("/api/agent-keys/"), routes.join(","));
  assert.ok(routes.includes("/api/agent-webhooks/"), routes.join(","));
  assert.ok(routes.includes("/api/agent-manifest"), routes.join(","));
  const map = buildCapabilities(routes);
  assert.equal(map["agent-keys"], true);
  assert.equal(map["webhooks"], true);
});

test("checked-in deploy/capabilities.mjs matches a fresh inventory", () => {
  const fresh = renderCapabilitiesModule(buildCapabilities(inventoryRoutes()));
  const checkedIn = readFileSync(join(root, "deploy", "capabilities.mjs"), "utf8");
  assert.equal(checkedIn, fresh, "run: node scripts/build-capabilities.mjs");
});

test("checked-in capabilities module exports the generated map", () => {
  assert.deepEqual(Object.keys(CAPABILITIES).sort(), FAMILY_NAMES.sort());
  for (const name of FAMILY_NAMES) assert.equal(typeof CAPABILITIES[name], "boolean", name);
});

test("card embeds deployed revision and generated capabilities", () => {
  const card = agentCard();
  const deployed = deployedInfo();
  assert.equal(card.deployed.revision, deployed.revision);
  assert.equal(card.deployed.buildId, deployed.buildId);
  assert.equal(card.deployed.version, "https://room.trydemigod.com/api/version");
  for (const name of FAMILY_NAMES) {
    assert.equal(card.capabilities[name], CAPABILITIES[name], name);
  }
  assert.equal(card.capabilities.stale, deployed.stale);
});

test("unstamped checkout serves the honest dev fallback", () => {
  // server/version.mjs ships "unstamped" placeholders; the test checkout is
  // never stamped, so the card must say dev and mark capabilities stale.
  const deployed = deployedInfo();
  assert.equal(deployed.revision, "dev");
  assert.equal(deployed.buildId, "dev");
  assert.equal(deployed.stale, true);
  const card = agentCard();
  assert.equal(card.deployed.revision, "dev");
  assert.equal(card.capabilities.stale, true);
  assert.match(llmsTxt(), /^deployed-rev dev dev$/m);
  assert.match(llmsFullTxt(), /deployed-rev dev dev/);
});

test("pushNotifications is true when this tip can register an HTTPS wakeUrl", () => {
  // The card is global and signed at build time. Host rows are per identity,
  // so the flag tracks wake registration + webhook delivery on the tip.
  assert.equal(buildCapabilities(["/api/agent-heartbeats"])["agent-heartbeats"], true);
  assert.equal(buildCapabilities(["/api/agent-heartbeats/ack"])["agent-heartbeats"], true);
  assert.equal(buildCapabilities(["/api/agent-webhooks"])["agent-heartbeats"], false);
  assert.equal(buildCapabilities(["/api/agent-heartbeat"])["agent-heartbeats"], false);
  const inventoried = buildCapabilities(inventoryRoutes());
  assert.equal(inventoried["agent-heartbeats"], true, "POST /api/agent-heartbeats is mounted");
  assert.equal(inventoried.webhooks, true);
  assert.equal(pushNotificationsSupported({ webhooks: true, "agent-heartbeats": true }), true);
  assert.equal(pushNotificationsSupported({ webhooks: true, "agent-heartbeats": false }), false);
  assert.equal(pushNotificationsSupported({ webhooks: false, "agent-heartbeats": true }), false);
  assert.equal(pushNotificationsSupported({}), false);
  const card = agentCard();
  assert.equal(card.capabilities.pushNotifications, true);
  assert.equal(card.capabilities["agent-heartbeats"], true);
  assert.equal(card.capabilities.webhooks, true);
  assert.equal(JSON.parse(agentCardJson()).capabilities.pushNotifications, true);
});

test("card JSON parses and keeps the A2A-required capabilities field", () => {
  const card = JSON.parse(agentCardJson());
  assert.equal(typeof card.capabilities, "object");
  assert.equal(card.protocol, "project-room-discovery");
  assert.ok(card.deployed.revision.length > 0);
});
