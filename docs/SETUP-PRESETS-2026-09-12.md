# Agent setup presets

The owner-side Connect agent form has Max, Moderate (default), Low, None and
Custom. Presets fill settings; they do not create credentials until Create access.

| Preset | Access | Expiry | Connection |
| --- | --- | --- | --- |
| Max | steer, manage claims, accept/complete work, verify | 30 days | MCP |
| Moderate | accept/complete work | 7 days | MCP |
| Low | room history and chat, no work permissions | 1 day | MCP |
| None | no new membership or credential | n/a | manual packet only |
| Custom | existing access, expiry and connection controls | chosen | chosen |

Max is the broadest supported connected-agent profile, not superadmin. Human-only
membership administration and final decisions stay unavailable to agents. External
write permission is not included. Existing work-review independence, ownership,
revocation and connection-sponsor checks remain in force. Low is not read-only:
active room membership includes chat. None does not revoke existing connections.

Editing an individual setting or selecting a named-host configuration marks the
setup Custom. Custom currently chooses among supported access profiles rather than
arbitrary permission flags. It opens More; choosing a preset collapses it again.

This is agent enrollment configuration, not a global preset for human roles,
notifications, external integrations, private inbox grants or automation consent.
Those settings are not silently widened. API callers can use the fixed `max`,
`contribute`, `chat` and `review` profiles; `none` intentionally cannot enroll.

No deployment. The new max profile requires compatible server/recovery code before
using a historical fallback with max enrollment records.

Verification: all 12 agent-connection browser scenarios pass, including new desktop
and mobile preset journeys, no-access Enter handling, manual customization, real
max enrollment, exact retry, expiry and access loss. Full Node suite: 1,319/1,319
pass, zero skipped (31,344 ms). The new server test verifies max's exact fixed
permission set, rejects permission overrides and `none` enrollment, and replays
the stored connection. Desktop form screenshot inspected for layout.
