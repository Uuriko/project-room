import test from "node:test";
import assert from "node:assert/strict";
import { channelDirectory, channelSidebar, directConversation, parseChannelSearch } from "../src/channels.js";

const rows = [
  { id: "general", kind: "channel", name: "General", workspaceId: "acme", unread: 4, updatedAt: "2026-09-14T18:00:00.000Z" },
  { id: "dm:z", kind: "dm", name: "Zoe", memberIds: ["me", "zoe"], unread: 1, updatedAt: "2026-09-14T19:00:00.000Z" },
  { id: "random", kind: "channel", name: "Random", workspaceId: "acme", unread: 0, updatedAt: "2026-09-14T17:00:00.000Z" }
];

test("A1/A2 directory normalizes vocabulary and sorts named channels before DMs", () => {
  assert.deepEqual(channelDirectory(rows), [
    { id: "general", kind: "channel", name: "General", workspaceId: "acme", memberIds: [], unread: 4, updatedAt: "2026-09-14T18:00:00.000Z" },
    { id: "random", kind: "channel", name: "Random", workspaceId: "acme", memberIds: [], unread: 0, updatedAt: "2026-09-14T17:00:00.000Z" },
    { id: "dm:z", kind: "dm", name: "Zoe", workspaceId: null, memberIds: ["me", "zoe"], unread: 1, updatedAt: "2026-09-14T19:00:00.000Z" }
  ]);
  assert.throws(() => channelDirectory([{ id: "x", kind: "room", name: "X" }]), /kind/);
  assert.throws(() => channelDirectory([{ id: "x", kind: "channel", name: "X", workspaceId: "w" }, { id: "x", kind: "channel", name: "Y", workspaceId: "w" }]), /duplicate/);
});

test("A3 sidebar is a stable projection and preserves selected channel when still visible", () => {
  assert.deepEqual(channelSidebar(rows, { selectedId: "dm:z" }), {
    selectedId: "dm:z", unread: 5,
    sections: [
      { id: "channels", label: "Channels", items: [{ id: "general", label: "General", unread: 4 }, { id: "random", label: "Random", unread: 0 }] },
      { id: "direct", label: "Direct messages", items: [{ id: "dm:z", label: "Zoe", unread: 1 }] }
    ]
  });
  assert.equal(channelSidebar(rows, { selectedId: "gone" }).selectedId, "general");
});

test("A4 direct conversations are canonical pairs and deny self, missing, or oversized membership", () => {
  assert.deepEqual(directConversation("zoe", "me"), { id: "dm:me:zoe", kind: "dm", memberIds: ["me", "zoe"] });
  assert.throws(() => directConversation("me", "me"), /distinct/);
  assert.throws(() => directConversation("", "zoe"), /member/);
  assert.throws(() => channelDirectory([{ id: "d", kind: "dm", name: "Bad", memberIds: ["a", "b", "c"] }]), /exactly two/);
});

test("A11 search modifiers are removed from text and normalized without weakening unknown terms", () => {
  assert.deepEqual(parseChannelSearch(' deploy status in:general from:zoe has:file is:unread '), {
    text: "deploy status", in: ["general"], from: ["zoe"], has: ["file"], is: ["unread"], unknown: []
  });
  assert.deepEqual(parseChannelSearch('"exact phrase" in:general in:random nope:value'), {
    text: '"exact phrase" nope:value', in: ["general", "random"], from: [], has: [], is: [], unknown: ["nope:value"]
  });
  assert.throws(() => parseChannelSearch("in:"), /value/);
});
