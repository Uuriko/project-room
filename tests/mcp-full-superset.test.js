// UT26 lane 10 F4 (10-4): profile "full" must be a true superset.
// Before this cure, room_search_actions / room_run_action were listed only
// in the lean profile, so the discovery escape hatch was itself hidden from
// the profile documented as "every tool", and the identity-mint description
// promised a fresh identity the enrolled room profile it does not get.
import test from "node:test";
import assert from "node:assert/strict";
import { listedMcpTools } from "../server/mcp-discovery.mjs";
import { identityMintMcpDefinitions } from "../server/mcp-identity-mint.mjs";

const names = tools => tools.map(tool => tool.name);

test("full profile is a superset of lean, core and every focus view", () => {
  const full = names(listedMcpTools("full"));
  const fullSet = new Set(full);
  assert.equal(full.length, fullSet.size, "full lists no tool twice");
  for (const profile of ["lean", "core"]) {
    for (const name of names(listedMcpTools(profile))) {
      assert.ok(fullSet.has(name), `full must include ${name} from ${profile}`);
    }
  }
  for (const focus of ["work", "conversation", "review", "automation", "public_work"]) {
    for (const name of names(listedMcpTools("core", false, null, focus))) {
      assert.ok(fullSet.has(name), `full must include ${name} from focus=${focus}`);
    }
  }
  for (const name of ["room_search_actions", "room_run_action"]) {
    assert.equal(full.filter(entry => entry === name).length, 1, `full lists ${name} exactly once`);
  }
});

test("mint description does not promise a fresh identity the enrolled room profile", () => {
  const description = identityMintMcpDefinitions[0].description;
  assert.doesNotMatch(description, /to unlock the enrolled room profile/);
  assert.match(description, /member/, "the enrolled profile is conditioned on room membership");
  assert.match(description, /public-work/, "the fresh-identity catalog is named honestly");
});
