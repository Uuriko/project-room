# Reviewed sponsorship of an existing OAuth agent seat

Runtime candidate: `a25187173b4b57c0e3ba4f5a9e834aa86490420a`, isolated from storage release, based on `f813130af`. No push, deployment, live credentials or live account changes.

The original DCR browser flow returns 409 when an account-bound human is not the existing agent's sponsor. The same executable HTTP fixture passes on the candidate: the human requests sponsorship inside OAuth consent, the current owner approves the existing access-request queue item, then the human returns to allow Claude's exact existing seat. The flow does not create an agent, change room ownership or alter permissions.

The request is stored using the existing `access_requests` lifecycle with a typed `pending_upgrade` payload. Prior parsers refuse that unsupported kind rather than admitting another member. Recipient consent binds the actual account-to-human membership, account epoch, identity epoch, both member revisions, ownership revision and exact existing permissions. Approval emits a membership event carrying the intent digest; direct commands cannot manufacture this event without the request service's synchronous capability. Approved OAuth bindings require both retained recipient and decision evidence. Administrator approval requires `manage_members`, `decide` and every permission already held by the selected agent.

Approval atomically revokes only the selected seat's old OAuth codes/access/refresh and invitation grants. Its existing managed connection credential is revoked, while its immutable operation journal and connection row remain unchanged. Existing revision authority therefore reports `access_changed`; no synthetic credential or fabricated connection operation is written. New OAuth consent uses an explicit `account-adopted-agent` binding and normal resource, PKCE, CSRF, scope, token and refresh rules.

Current-room reads include independently protected addressed facts for the selected agent and its human sponsor. The new command uses the existing bounded current-record context and reducer. Native qualification uses the production `ProjectRoom` constructor, actual Durable SQLite, an agent-owned normalized room, an interrupted approval save, four cold restarts, unchanged identity/member/permission facts, independent full recovery audit, OAuth exchange, refresh and MCP access as the same seat.

See `acceptance.json` and compressed logs. Eighty affected Node controls, sixteen final core controls (overlapping), one production Native journey and two package/preflight controls passed. Original HTTP red is preserved. The full-tree secret scan passed over 1,877 files; focused new source/test lint had zero errors. Broader affected files retain existing warnings.

## Live prerequisite and release boundary

The signed-in account must already be verifiably bound to the intended active human member. This candidate refuses an absent or different `member_accounts` binding; it does not infer account ownership from “John”, an email address or a provider label, merge accounts, or silently reassign another human membership. Root must establish the actual live account-binding evidence before using this flow for the existing Claude seat. No real Claude-host, Android or visual browser qualification is claimed.

No schema migration or format-token change is introduced. The new event, request discriminator and OAuth principal must ship together; rollback code cannot interpret the new event for replay and must not be used to certify new history. Persisted selected-grant revocations and changed accountability fence old sponsor access. This is separate from the normalized-storage release and does not certify that release or solve a production outage.
