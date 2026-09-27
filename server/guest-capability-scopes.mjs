// Additive capability overrides leave legacy GX tier rows untouched.
// A scope row on an invite is copied only for a new redeemed seat;
// re-redemption cannot undo an owner's later downgrade.
export const guestCapabilitySchema = `
  CREATE TABLE IF NOT EXISTS guest_capability_scopes (
    kind TEXT NOT NULL CHECK(kind IN ('invite','member')),
    id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('read_only','chat_only')),
    PRIMARY KEY(kind,id)
  );
`;
export const guestCapabilities = Object.freeze({
  read_only: Object.freeze(["guest:read"]),
  chat_only: Object.freeze(["guest:post"]),
});
