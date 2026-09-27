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

// Older writers can ignore scope rows, but cannot bypass these SQLite guards.
// A scoped bearer is registered by hash before insert; the old writer neither
// knows this table nor can synthesize a preauthorization. No plaintext secrets.
export const guestCapabilityRollbackSchema = `
  CREATE TABLE IF NOT EXISTS guest_scoped_credentials (
    hash TEXT PRIMARY KEY CHECK(length(hash)=64),
    member_id TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS guest_scoped_credential_no_update BEFORE UPDATE ON guest_scoped_credentials
  BEGIN SELECT RAISE(ABORT, 'scoped credential authorization is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS guest_scoped_credential_no_delete BEFORE DELETE ON guest_scoped_credentials
  BEGIN SELECT RAISE(ABORT, 'scoped credential authorization is retained'); END;
  CREATE TRIGGER IF NOT EXISTS guest_scoped_credential_insert BEFORE INSERT ON credentials
  WHEN EXISTS (SELECT 1 FROM guest_capability_scopes WHERE kind='member' AND id=NEW.member_id)
    AND NOT EXISTS (SELECT 1 FROM guest_scoped_credentials WHERE hash=NEW.hash AND member_id=NEW.member_id)
  BEGIN SELECT RAISE(ABORT, 'scoped guest credential required'); END;
  CREATE TRIGGER IF NOT EXISTS guest_scoped_credential_delete BEFORE DELETE ON credentials
  WHEN EXISTS (SELECT 1 FROM guest_capability_scopes WHERE kind='member' AND id=OLD.member_id)
  BEGIN SELECT RAISE(ABORT, 'restricted guest credentials are retained'); END;
  CREATE TRIGGER IF NOT EXISTS guest_scoped_credential_reactivate BEFORE UPDATE OF revoked ON credentials
  WHEN NEW.revoked=0 AND EXISTS (SELECT 1 FROM guest_capability_scopes WHERE kind='member' AND id=NEW.member_id)
    AND NOT EXISTS (SELECT 1 FROM guest_scoped_credentials WHERE hash=NEW.hash AND member_id=NEW.member_id)
  BEGIN SELECT RAISE(ABORT, 'scoped guest credential required'); END;
  CREATE TRIGGER IF NOT EXISTS guest_scoped_credential_invite_delete BEFORE DELETE ON guest_capability_scopes
  WHEN OLD.kind='invite' AND EXISTS (SELECT 1 FROM guest_invites WHERE id=OLD.id AND status='active')
  BEGIN SELECT RAISE(ABORT, 'scoped guest invite guard is retained'); END;
  CREATE TRIGGER IF NOT EXISTS guest_scoped_credential_invite_update BEFORE UPDATE OF scope ON guest_capability_scopes
  WHEN OLD.kind='invite' AND EXISTS (SELECT 1 FROM guest_invites WHERE id=OLD.id AND status='active')
  BEGIN SELECT RAISE(ABORT, 'scoped guest invite guard is retained'); END;
  CREATE TRIGGER IF NOT EXISTS guest_scoped_credential_scope_insert BEFORE INSERT ON guest_capability_scopes
  WHEN NEW.kind='member' AND EXISTS (SELECT 1 FROM credentials WHERE member_id=NEW.id AND revoked=0)
  BEGIN SELECT RAISE(ABORT, 'revoke guest credentials before restricted scope'); END;
  CREATE TRIGGER IF NOT EXISTS guest_scoped_credential_scope_delete BEFORE DELETE ON guest_capability_scopes
  WHEN OLD.kind='member' AND EXISTS (SELECT 1 FROM guest_scoped_credentials WHERE member_id=OLD.id)
  BEGIN SELECT RAISE(ABORT, 'scoped guest seat cannot be restored by an older writer'); END;
  CREATE TRIGGER IF NOT EXISTS guest_scoped_credential_scope_update BEFORE UPDATE OF scope ON guest_capability_scopes
  WHEN NEW.kind='member' AND EXISTS (SELECT 1 FROM credentials WHERE member_id=NEW.id AND revoked=0)
  BEGIN SELECT RAISE(ABORT, 'revoke guest credentials before restricted scope'); END;
`;
