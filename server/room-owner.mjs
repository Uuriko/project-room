// Owner lookup that never builds the full member census on real stores.
// The roomAuthority() fallback exists only for injected test/stub stores that
// predate store.roomOwnerId(); it is the single grandfathered call site.
export function roomOwnerIdOf(store, roomId) {
  if (typeof store.roomOwnerId === "function") return store.roomOwnerId(roomId);
  return store.roomAuthority(roomId)?.ownerId;
}
