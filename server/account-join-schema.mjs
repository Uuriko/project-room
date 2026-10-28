// Additive persistence contract shared by the feature and schema-aware fallback.
export const accountJoinRequestsSchema = `
CREATE TABLE IF NOT EXISTS account_join_requests (
 request_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
 account_id TEXT NOT NULL REFERENCES accounts(id), fingerprint TEXT NOT NULL,
 display_name TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 decided_at INTEGER, decided_by TEXT, member_id TEXT
);
CREATE INDEX IF NOT EXISTS account_join_requests_account ON account_join_requests(account_id, created_at DESC, request_id);
CREATE INDEX IF NOT EXISTS account_join_requests_room ON account_join_requests(room_id, status, created_at, request_id);
`;
