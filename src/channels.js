const kinds = new Set(["channel", "dm"]);
const text = (value, label) => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
};

export function directConversation(left, right) {
  const memberIds = [text(left, "member"), text(right, "member")].sort();
  if (memberIds[0] === memberIds[1]) throw new TypeError("Direct conversation members must be distinct");
  return Object.freeze({ id: `dm:${memberIds.join(":")}`, kind: "dm", memberIds: Object.freeze(memberIds) });
}

export function channelDirectory(input = []) {
  if (!Array.isArray(input)) throw new TypeError("Channel directory must be an array");
  const ids = new Set();
  return input.map(row => {
    if (!row || typeof row !== "object") throw new TypeError("Channel entry must be an object");
    const id = text(row.id, "Channel id"), name = text(row.name, "Channel name");
    if (ids.has(id)) throw new TypeError(`Channel directory contains duplicate id ${id}`);
    ids.add(id);
    if (!kinds.has(row.kind)) throw new TypeError("Channel kind must be channel or dm");
    const memberIds = row.memberIds == null ? [] : [...row.memberIds].map(value => text(value, "member"));
    if (row.kind === "dm" && (memberIds.length !== 2 || new Set(memberIds).size !== 2)) throw new TypeError("Direct conversation requires exactly two distinct members");
    return Object.freeze({ id, kind: row.kind, name, workspaceId: row.kind === "channel" ? text(row.workspaceId, "Workspace id") : null,
      memberIds: Object.freeze(memberIds.sort()), unread: Number.isInteger(row.unread) && row.unread >= 0 ? row.unread : 0,
      updatedAt: row.updatedAt == null ? null : text(row.updatedAt, "Updated time") });
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function channelSidebar(input, { selectedId = null } = {}) {
  const rows = channelDirectory(input), visible = new Set(rows.map(row => row.id));
  const item = row => Object.freeze({ id: row.id, label: row.name, unread: row.unread });
  return Object.freeze({ selectedId: visible.has(selectedId) ? selectedId : rows[0]?.id ?? null,
    unread: rows.reduce((sum, row) => sum + row.unread, 0), sections: Object.freeze([
      Object.freeze({ id: "channels", label: "Channels", items: Object.freeze(rows.filter(row => row.kind === "channel").map(item)) }),
      Object.freeze({ id: "direct", label: "Direct messages", items: Object.freeze(rows.filter(row => row.kind === "dm").map(item)) })
    ]) });
}

const modifiers = new Set(["in", "from", "has", "is"]);
export function roomsToChannelEntries(rooms, workspaceId = "account") {
  if (!Array.isArray(rooms)) throw new TypeError("Rooms must be an array");
  return rooms.map(room => {
    if (!room || typeof room !== "object") throw new TypeError("Room entry must be an object");
    const id = String(room.id ?? "").trim();
    const title = typeof room.title === "string" ? room.title.trim() : "";
    return { id, kind: "channel", name: title || id, workspaceId, unread: Number.isInteger(room.unread) && room.unread >= 0 ? room.unread : 0 };
  });
}

export function accountRoomsSidebar(rooms, { selectedId = null, workspaceId = "account" } = {}) {
  return channelSidebar(roomsToChannelEntries(rooms, workspaceId), { selectedId });
}

export function roomMemberDirectMessages(viewerId, members) {
  const viewer = text(viewerId, "viewer");
  const list = Array.isArray(members) ? members : Object.values(members && typeof members === "object" ? members : {});
  return list.filter(member => member && typeof member === "object" && typeof member.id === "string"
    && member.id !== viewer && member.active !== false && member.kind !== "agent")
    .map(member => {
      const pair = directConversation(viewer, member.id);
      const name = typeof member.displayName === "string" && member.displayName.trim() ? member.displayName.trim() : member.id;
      return Object.freeze({ ...pair, name });
    });
}

export function parseChannelSearch(query) {
  if (typeof query !== "string") throw new TypeError("Search query must be a string");
  const result = { text: "", in: [], from: [], has: [], is: [], unknown: [] }, words = query.trim().match(/"[^"]*"|\S+/g) ?? [], kept = [];
  for (const word of words) {
    const match = /^([a-z]+):(.*)$/i.exec(word);
    if (!match || !modifiers.has(match[1].toLowerCase())) { kept.push(word); if (match) result.unknown.push(word); continue; }
    if (!match[2]) throw new TypeError(`Search modifier ${match[1]} requires a value`);
    const key = match[1].toLowerCase();
    if (!result[key].includes(match[2])) result[key].push(match[2]);
  }
  result.text = kept.join(" ");
  return Object.freeze(result);
}
