// Public Room deep-link: #room/{roomId}
// Open and People honor this fragment. Query ?room= stays the account-home twin.

export const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const ROOM_HASH_PATTERN = /^#room\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/;
export const PUBLIC_ROOM_DOOR = "https://www.getdasha.com/room";

export function roomIdFromHash(hash) {
  const match = ROOM_HASH_PATTERN.exec(String(hash ?? ""));
  return match && ROOM_ID_PATTERN.test(match[1]) ? match[1] : null;
}

export function publicRoomDeepLink(roomId) {
  if (!ROOM_ID_PATTERN.test(String(roomId ?? ""))) return "";
  return `${PUBLIC_ROOM_DOOR}#room/${roomId}`;
}

export function selectedRoomFromLocation({ search = "", hash = "" } = {}) {
  const fromHash = roomIdFromHash(hash);
  if (fromHash) return fromHash;
  const query = String(search ?? "");
  const values = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query).getAll("room");
  return values.length === 1 && ROOM_ID_PATTERN.test(values[0]) ? values[0] : null;
}
