# Plugin System Prototype

Standalone, additive prototype of a plugin system for Project Room —
**nothing here is wired into `server/`, `client/`, routes, or imports**.
Evaluate it, test it, throw it away; main is untouched.

## What it is

- `docs/SPEC.md` — the design: manifest format, lifecycle state machine,
  sandboxed execution boundary, threat model.
- `src/` — reference implementation (Node 20+, zero dependencies):
  - `manifest.mjs` — `plugin.json` parsing + fail-closed validation
    (manifestVersion 1, name/semver/entry rules, hook + capability allowlists)
  - `registry.mjs` — `install` / `enable` / `disable` / `uninstall` with a
    strict state machine, journal, and fail-closed timeout auto-disable
  - `sandbox.mjs` — `node:vm` execution boundary: frozen primordials, denied
    globals (`process`, `require`, `fetch`, `WebAssembly`, …), CPU timeouts
    on entry evaluation and every hook call, structured-clone-only data flow
  - `host-api.mjs` — capability-gated `plugin.api` (`log`, `storage.kv`,
    `timers`); host functions are prototype-stripped so
    `api.fn.constructor` can't reach the host `Function`
  - `hooks.mjs` — fan-out dispatch with per-plugin error isolation
- `fakes/` — `FakeFiles`, `FakeKV`, `FakeLogSink` (the whole suite runs on
  these; zero host I/O), plus `FsPluginFiles`, a production-shaped local-fs
  adapter for the demo path
- `examples/` — `greet` (config + timers), `audit` (namespaced `storage.kv`),
  `evil` (adversarial: tries every escape; used by tests)
- `tests/` — 38 tests via `node:test`, no dependencies

## Run it

```sh
cd plugin-prototype
node --test tests/*.test.js   # 38 tests, all hermetic
node demo.mjs                  # end-to-end walkthrough on fakes
```

## Design notes

- Install never runs code. Enable builds the sandbox; any failure leaves
  state unchanged. Disable tears down the sandbox and kills pending timers.
- A hook handler that exceeds its CPU budget is reported as timed out and
  the plugin is auto-disabled (fail-closed, with re-entrancy guard).
- `node:vm` is an isolation boundary for untrusted-but-not-adversarial
  code (same posture as extension content scripts), not a hardened
  security sandbox — the `Sandbox` class is the seam for a worker-thread
  or subprocess backend later.
