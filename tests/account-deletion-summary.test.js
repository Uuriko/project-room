// The delete dialog speaks plainly: what goes, which rooms are archived,
// passed on or left, and what is kept. No category counts or internal names.
import test from "node:test";
import assert from "node:assert/strict";
import { deletionPlainSummary } from "../src/account-settings-ui.js";

const room = (id, title) => ({ id, title });

test("plain deletion summary names rooms by title and hides the inventory", () => {
  const lines = deletionPlainSummary({
    summary: { text: "Account deletion: 18 categories purged (9 items)…\nstitch (0 items)" },
    plan: { rooms: { archive: [room("personal-x", "My first room")], transfer: [room("team", "Team")], blocked: [], retained: [room("trip", "Lisbon trip")] } },
  });
  assert.match(lines[0], /permanently deletes your account/);
  assert.ok(lines.includes("Rooms you own that will be archived: My first room."));
  assert.ok(lines.includes("Rooms that pass to another owner: Team."));
  assert.ok(lines.includes("You'll leave the other rooms you're in: Lisbon trip."));
  assert.match(lines.at(-1), /Security and access history is kept/);
  const all = lines.join("\n");
  for (const leak of ["categories", "items)", "stitch", "personal-x"]) assert.equal(all.includes(leak), false, leak);
});

test("long room lists are capped, and a plan with no rooms still explains itself", () => {
  const many = Array.from({ length: 8 }, (_, i) => room(`r${i}`, `Room ${i}`));
  const lines = deletionPlainSummary({ plan: { rooms: { archive: many } } });
  assert.ok(lines.includes("Rooms you own that will be archived: Room 0, Room 1, Room 2, Room 3, Room 4 and 3 more."));
  assert.equal(deletionPlainSummary({}).length, 2);
  assert.equal(deletionPlainSummary({ plan: { rooms: { archive: [room("untitled", "")] } } })[1], "Rooms you own that will be archived: untitled.");
});
