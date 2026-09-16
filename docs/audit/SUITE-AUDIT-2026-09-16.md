# Core suite audit

16 September 2026. Claude (Cowork). Read-only audit. No file of anyone else's was edited.

## What was run

`node --test tests/*.test.js` across all 128 test files in `tests/`.

**1082 tests, 1061 pass, 21 fail.** Of those 21, **four are a real defect** that will
break CI, one committed script has the same class of problem at lower severity,
and the remaining seventeen are an artifact of the machine I ran on and are not
repo defects. The three tiers are separated below so nobody spends time on the
wrong one.

## Tier 1: four tests will turn CI red the moment they are committed

| File | Hardcoded path |
| --- | --- |
| `tests/attachment-http-g7.test.js` | `/Users/johnpotter/src/project-room-integration/server/store.mjs` |
| `tests/recovery-boundary-review.test.js` | `/Users/johnpotter/src/project-room-identity-scope` |
| `tests/recovery-stale-snapshot.test.js` | `/Users/johnpotter/src/project-room-identity-scope` |
| `tests/session-policy-boundary.test.js` | `/Users/johnpotter/src/project-room-identity-scope` |

All four are currently untracked, and all four pass on the Mac they were written
on, because those sibling worktrees really are checked out at exactly those paths.
That is precisely what makes this easy to miss.

The failure is not hypothetical. `npm run check` ends in
`spawnSync(process.execPath, ["--test"])` (`scripts/check.mjs:14`), and the
`contract` job in `.github/workflows/test.yml` runs `npm run check` on node 24 on
`ubuntu-latest`. There is no `/Users/johnpotter` on a GitHub runner. Three of the
files assert `existsSync(...)` at module top level and the fourth does a top-level
`await import(...)` of an absolute path, so each one throws during module
evaluation, `node --test` exits non-zero, and the contract job fails. Committing
them is enough; no other change is needed to break the build.

It also already bites any agent working from a different checkout. Running the
suite from the Cowork mount is how this was found.

### Verified fix

Resolve the sibling worktree relative to the repo rather than to one machine's
home, and skip rather than hard-fail when it is absent. Verified working from a
mount where the absolute path does not exist:

```js
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const storePath = fileURLToPath(
  new URL("../../project-room-identity-scope/server/store.mjs", import.meta.url));
const available = existsSync(storePath);

if (!available) {
  test("identity-scope worktree not present; probes skipped", { skip: true }, () => {});
} else {
  const { RoomStore } = await import(pathToFileURL(storePath).href);
  // existing body unchanged
}
```

The skip matters as much as the relative path. These are deliberate cross-worktree
probes, so somebody without that sibling checkout should get a skip, not a red
suite. That keeps the probe running where the worktree exists and keeps CI green
everywhere else.

## Tier 2: one committed script only runs on one machine

`scripts/native-host-request-run.mjs` is tracked, and line 36 hardcodes
`/Users/johnpotter/.local/bin/claude`, with the sibling branch hardcoding
`/Applications/ChatGPT.app/Contents/Resources/codex`.

Lower severity: its guard test (`tests/native-host-run-guards.test.js`) passes, so
CI is unaffected. But no other contributor and no other agent can run the
native-host exercise, and the failure mode is a confusing missing-binary error
rather than a clear message. An environment variable with a documented default,
or a clear skip when the binary is absent, would fix it.

## Tier 3: seventeen failures that are my environment, not the repo

The remaining failures are in `tests/watch-cli.test.js`, `tests/email-import.test.js`,
`tests/external-producer.test.js`, `tests/help-mcp.test.js` and neighbours. Every
one spawns a child process and parses its output. The actual error is:

```
Unexpected token '(', "(node:36) "... is not valid JSON
```

That is a node process warning landing in stdout that the test parses as JSON.
This mount runs **node 22.23.2** while `package.json` requires **>=24.19.0**, and
node 22 emits experimental warnings that node 24 does not. These are not repo
defects and they should pass on a supported runtime.

One thing worth stating so nobody chases it: `.github/workflows/hosted-denial-conformance.yml`
pins `node-version: 22`, which looks like it contradicts the engine pin. It does
not. That job sets `working-directory: hosted-denial-conformance`, an isolated
subpackage whose own `package.json` declares `"node": ">=20"` and whose test
script uses the explicit `node --test tests/*.test.js` glob rather than node 24
directory discovery. That workflow is correct as written.

## What was deliberately not done

None of the four Tier 1 files were edited. They are untracked, which under the
shared occupancy rule means another agent is holding them. The diagnosis and the
verified patch are here and on the channel so whoever owns them can apply it in
about a minute.
