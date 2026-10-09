# Plugin System Prototype — Specification

Standalone design prototype for a Project Room plugin system. Additive only:
nothing here is wired into `server/`, `client/`, routes, or imports. It can be
evaluated, tested, and thrown away without touching main.

## 1. Goals

- Third-party code can extend room behavior without host trust.
- Install/enable/disable/uninstall have crisp, auditable semantics.
- A plugin can never read host secrets, touch the host filesystem/network,
  escape its sandbox, or break other plugins.

## 2. Manifest format (`plugin.json`, manifestVersion 1)

```json
{
  "manifestVersion": 1,
  "name": "greet",
  "version": "1.2.0",
  "description": "Greets new members",
  "author": "jill",
  "entry": "index.js",
  "hooks": ["room.member.joined"],
  "capabilities": ["log", "storage.kv", "timers"],
  "config": { "greeting": "hello" }
}
```

Field rules (all enforced at install time; violations reject the install):

| Field | Rule |
|---|---|
| `manifestVersion` | integer, must be `1` (unknown versions rejected) |
| `name` | `^[a-z0-9][a-z0-9-]{0,63}$` — lowercase, URL/directory safe, unique per host |
| `version` | strict semver `MAJOR.MINOR.PATCH`, no build metadata, no `v` prefix |
| `description` | string, 1–280 chars |
| `author` | string, 1–120 chars |
| `entry` | relative path inside the plugin dir; no `..`, no absolute paths, must exist, must end in `.js` |
| `hooks` | array of names from the hook allowlist (below); duplicates rejected |
| `capabilities` | array of names from the capability allowlist (below); unknown capability → reject |
| `config` | optional object; deep-frozen before the plugin sees it |

### Hook allowlist (v1)

`room.message.posted`, `room.member.joined`, `room.member.left`,
`work.claim.created`, `work.claim.completed`, `plugin.enabled`, `plugin.disabled`.

A hook payload is plain JSON (structured-cloneable). Handlers return
`{ ok: true }` or `{ ok: false, error }`; return values are serialized back
through the boundary (functions, promises, and host objects never cross).

### Capability allowlist (v1)

| Capability | Exposes to plugin |
|---|---|
| `log` | `api.log(level, ...args)` — captured by host, never the raw console |
| `storage.kv` | `api.storage.get/set/del/keys` — namespaced to `plugin:<name>:` |
| `timers` | `setTimeout/clearTimeout` — tracked; all pending timers killed on disable |

No capability may grant: network, filesystem, subprocess, `require`/module
loading, host object references, or cross-plugin storage.

## 3. Lifecycle

```
              install
   (absent) ──────────▶ INSTALLED ──enable──▶ ENABLED
                             │                   │ disable
                             │                   ▼
                             │               DISABLED ──enable──▶ ENABLED
                             │                   │
                             └──────┬────────────┘
                                    │ uninstall
                                    ▼
                                 (removed)
```

Semantics:

- **install(sourceDir)**: validate manifest (schema + allowlists); reject if a
  plugin with the same `name` is already installed; copy files into the
  host's plugin dir; record `INSTALLED`. No code runs at install time.
- **enable(name)**: only from `INSTALLED`/`DISABLED`; build the sandbox,
  freeze config, evaluate the entry file with a CPU timeout, register its
  hooks; state → `ENABLED`. Any failure leaves state unchanged.
- **disable(name)**: only from `ENABLED`; unregister hooks, destroy the
  sandbox context, clear pending timers; state → `DISABLED`.
- **uninstall(name)**: from `INSTALLED`/`DISABLED` directly, from `ENABLED`
  by disabling first; delete files and registry record.
- Invalid transitions throw `LifecycleError`; unknown names throw
  `NotFoundError`. All transitions are synchronous in the reference build and
  recorded in the registry journal.

## 4. Sandboxed execution boundary

Plugins run in `node:vm` contexts with:

- **Denied**: `process`, `require`, `module`, `__dirname`, `__filename`,
  `fetch`, `fs`, `child_process`, `eval`/`Function` constructor (host policy;
  the context itself is compiled once by the host), `WebAssembly`,
  `queueMicrotask` (unless `timers`), `globalThis` pollution of the host.
- **Allowed**: frozen intrinsics (`Object`, `Array`, `JSON`, `Math`, `Date`,
  `String`, … — primordial prototypes frozen so a plugin cannot poison the
  host's shared builtins), a shimmed `console` (routes to `api.log`),
  `structuredClone`, and the capability-gated `plugin` API object.
- **Timeouts**: entry evaluation and every hook call run with a CPU timeout
  (default 1000 ms entry / 250 ms per hook); overrun throws and the plugin is
  auto-disabled (fail-closed).
- **No shared mutable state**: payloads and results cross the boundary by
  structured clone; the plugin's `api` object is a fresh proxy per plugin.

Threat model notes: `node:vm` is not a security boundary against a
determined adversary with a V8 0-day; it is a correctness/isolation boundary
for untrusted-but-not-adversarial plugin code (the same posture as browser
extensions' content scripts). Anything stronger (worker threads with no
`workerData` back-channel, or a subprocess per plugin) can be swapped in
behind the `Sandbox` interface — see `src/sandbox.mjs`.

## 5. Fakes

The reference build ships fakes so the whole system is testable with zero
host: `FakeStore` (in-memory plugin dir + registry persistence),
`FakeBus` (records hook dispatches), `FakeClock` (deterministic timers).
Production adapters would implement the same three interfaces.
