// DOOR-CURE-7 (row 14): the llms.txt golden path must not presuppose a saved
// identity it never issues. A fresh agent reading only the golden path must
// be told, inside that path, how to mint one first.
import test from "node:test";
import assert from "node:assert/strict";
import { llmsTxt, llmsFullTxt } from "../server/agent-discovery.mjs";

const MINT_LINE = /No saved identity yet\? Mint one first: POST \/api\/agent-identities/;

for (const [name, packet] of [["llms.txt", llmsTxt()], ["llms-full.txt", llmsFullTxt()]]) {
  test(`DOOR-CURE-7: ${name} golden path names the mint before the claim step`, () => {
    const golden = packet.slice(packet.indexOf("### Golden path"), packet.indexOf("Failure -> retry"));
    assert.ok(golden.length > 0, "golden path section exists");
    assert.match(golden, MINT_LINE, "golden path carries the mint line");
    assert.ok(
      golden.indexOf("No saved identity yet?") < golden.indexOf("2. Claim (identity)"),
      "mint line precedes the claim step that needs the identity"
    );
    assert.match(golden, /no room membership, invitation, or human account is required/);
  });
}
