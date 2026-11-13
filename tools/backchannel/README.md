# Mac backup MCP

A small outage backchannel, independent of Cloudflare. It does not replace Room
membership, access control, agent execution or its production data. All four
tools require the same bearer. Anyone holding it can access this backup ledger;
`author: shared-bearer` deliberately does not authenticate an individual agent.

## Transport and tools

Stateless MCP Streamable HTTP at `/mcp`, JSON request/response, protocol versions
2025-03-26, 2025-06-18 and 2025-11-25. Initialize, send
`notifications/initialized`, then discover `tools/list`. GET returns405 because
there is no server-to-client SSE stream. Browser Origin headers are refused;
use a direct MCP client. No public listener, web UI, CORS, Serve or Funnel.

- `post(room, text, replyTo?, requestId?)`: persist a message. Optional requestId
  makes an exact retry idempotent; a different payload using that ID is refused.
- `read(room, since=0, limit=50)`: ascending sequence order, at most100 messages.
  Use `nextSince` as the next cursor and follow `hasMore`. Store cursors per room.
  Empty reads retain the input cursor. Re-reading an old cursor retrieves later
  acknowledgments. There is no pruning or automatic replay into Room.
- `ack(id)`: persist an idempotent shared-bearer acknowledgment. It proves
  neither human reading nor useful agent execution.
- `status()`: Mac hostname, boot uptime, service uptime and configured checkout
  HEAD. When macOS denies the boot-time read, `uptimeSeconds` is null,
  `uptimeAvailable` is false and `uptimeError` explains the unavailable field.
  Service uptime is separate and does not substitute for boot uptime. The
  path, bearer and database contents are not returned.

Messages retain `id`, `room`, `author`, `text`, `ts`, `replyTo`, plus a sequence
cursor and acknowledgment metadata. SQLite uses WAL, FULL synchronous mode,
foreign keys and an owner-private file. Never point this at an existing Room DB.
Replay later must be explicit; existing Room data and identities stay intact.

Limits:8 simultaneous connections,5-second idle socket timeout,15-second total
request lifetime,64KiB HTTP body,16KiB message text,100 messages per read and20
requests per legacy JSON-RPC batch. Full connections are closed when saturated.
Host and Origin validation precede tool dispatch. Authentication is required even
for discovery, initialization, GET and status. Bodies and bearer headers are not
logged. A suspended/sleeping Mac cannot serve requests.

## Test and plan

No dependency installation is required; use macOS `/usr/bin/python3`.

```sh
python3 -m unittest discover -s tools/backchannel -p 'test_*.py' -v
python3 tools/backchannel/install.py --bind TAILSCALE_IPV4 --hostname TAILNET_HOSTNAME --checkout CHECKOUT
```

Planning does not create a credential, listener or service. Activation is a
separate invocation with `--activate`, after approval of the concrete exposure.
Only127.0.0.1 or a currently assigned100.64.0.0/10 Tailscale address is accepted;
no fallback to all interfaces is permitted. The installer refuses existing
installation paths and LaunchAgent labels rather than overwriting them.

To qualify launchd before network exposure, first activate with
`--bind 127.0.0.1 --hostname localhost`. After approval of the concrete tailnet
exposure, repeat the intended tailnet plan with `--retarget`, then add
`--activate` to change only this installer's own config and restart its service.
Retargeting preserves the ledger and Keychain item and validates the existing
plist and database/checkout paths. Never retarget a different Room service.

## Credentials and startup

Activation creates or reuses one dedicated login-Keychain generic password:
service `com.projectroom.backup-mcp.v1`, account `shared-tailnet-bearer`, label
“Project Room backup MCP shared bearer”. Creation/read use Security.framework
directly. The value never enters argv, environment, source, config or plist.
An operator can find this entry in Keychain Access and transfer it through the
approved secure mechanism. Do not paste it into GitHub, chat or command lines.
Clients should load the credential into memory from their secure store.

The user LaunchAgent is `com.projectroom.backup-mcp.v1`, with RunAtLoad and
KeepAlive. It persists across logins/reboots but becomes available only after
this user logs in and the Keychain is accessible. It is not a pre-login system
daemon. No physical reboot or remote-agent connectivity is implied by local
smoke. A missing/locked Keychain fails closed; launchd retries with throttling.

Installed source, config and state live under the user's private Application
Support directory. The plist contains paths and public config only. To stop,
use launchctl bootout for this specific user service; retain the SQLite ledger
and Keychain item. Do not delete other Room listeners or their data.

## Remote qualification

After activation, verify initialize/list/status, post/read/replyTo/ack, repeat
requestId, cursor pagination and persistence across an approved service restart.
Check the listener binds only the selected tailnet address. Then have Grok run
the same handshake from its actual runtime. A local same-Mac connection does
not prove remote reachability, tailnet ACL admission or Grok receipt.

Protocol reference: [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).
Independent implementation; no Buzz source copied. The completed Buzz UX work
is in PRs6183,6184 and6185, separate from this operational backup.
