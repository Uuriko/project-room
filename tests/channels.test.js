import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { channelDirectory, channelSidebar, directConversation, parseChannelSearch, roomsToChannelEntries, accountRoomsSidebar, roomMemberDirectMessages } from "../src/channels.js";

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

test("account rooms project through the channel sidebar without changing ids", () => {
  const rooms = [
    { id: "zeta", title: "Zeta" },
    { id: "alpha", title: "  Alpha  ", unread: 2 },
    { id: "bare" }
  ];
  assert.deepEqual(roomsToChannelEntries(rooms).map(row => row.id), ["zeta", "alpha", "bare"]);
  const sidebar = accountRoomsSidebar(rooms, { selectedId: "zeta" });
  assert.equal(sidebar.selectedId, "zeta");
  assert.deepEqual(sidebar.sections[0].items.map(item => item.id), ["alpha", "bare", "zeta"]);
  assert.equal(sidebar.unread, 2);
  assert.throws(() => roomsToChannelEntries("nope"), /array/);
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /accountRoomsSidebar\(accountRoomsCache\)/);
});

test("roomMemberDirectMessages projects other humans in this room as DM pairs", () => {
  const dms = roomMemberDirectMessages("me", {
    me: { id: "me", displayName: "Me", kind: "human" },
    zoe: { id: "zoe", displayName: "Zoe", kind: "human" },
    ann: { id: "ann", displayName: "Ann", kind: "human" },
    bot: { id: "bot", displayName: "Bot", kind: "agent" },
    gone: { id: "gone", displayName: "Gone", kind: "human", active: false }
  });
  assert.equal(dms.length, 2);
  assert.deepEqual(dms.map(row => row.name), ["Ann", "Zoe"]);
  assert.equal(dms[1].id, "dm:me:zoe");
  assert.equal(dms[0].kind, "dm");
  assert.equal(dms[0].name, "Ann");
  assert.deepEqual(dms[0].memberIds, ["ann", "me"]);
  assert.deepEqual(roomMemberDirectMessages("me", {
    me: { id: "me", displayName: "Me", kind: "human" },
    bot: { id: "bot", displayName: "Bot", kind: "agent" },
    gone: { id: "gone", displayName: "Gone", kind: "human", active: false }
  }), []);
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /roomMemberDirectMessages\(session\.member\.id, state\.members\)/);
  assert.match(app, /data-dm-member/);
  assert.match(app, /dms\.length \? `<p class="presence-heading">Direct messages<\/p>/);
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
