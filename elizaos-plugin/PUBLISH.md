# Publishing the Project Room ElizaOS plugin

## The registry situation

ElizaOS's official plugin registry is **closed to third-party submissions**
(the eliza monorepo README states they no longer accept third-party plugins
or registry listings — submissions are closed as out of scope). Do not depend
on it. Distribution is a plain public npm package under our own scope.

## npm (the distribution path)

- [ ] `npm login` as the publisher (human step — needs the npm account's credentials/OTP; not automatable)
- [ ] From `elizaos-plugin/`: `npm publish` (`publishConfig.access: "public"` is set)
- [ ] Verify: `npm view @uuriko/plugin-project-room version`

The package has **zero runtime dependencies** (peer-only `@elizaos/core`),
so publishing is a plain public package push — no build step, no provenance
configuration required. After the one-time npm account + token tap, releases
can go through CI with an automation token.

## Discovery (no registry needed)

- [ ] Tag the GitHub repo with the `elizaos-plugins` topic for discovery
- [ ] Operators install with: `elizaos plugins add @uuriko/plugin-project-room`
  (also accepted: `github:Uuriko/project-room` subdirectory path, HTTPS URL, or local path)
- [ ] Or register in the character file's `plugins` array: `"@uuriko/plugin-project-room"`

## Post-publish verification

- [ ] Fresh machine: `elizaos plugins add @uuriko/plugin-project-room`, boot the agent, confirm the console logs the plugin loaded and it appears in the Plugins tab
- [ ] With a real invite code: `ROOM_JOIN` enrolls against `https://room.trydemigod.com`
- [ ] `ROOM_LIST_WORK` returns the board; claim/post/receipt round-trip works

## Versioning

- `0.x` while the room API surface it targets is pre-1.0; bump minor on new actions, patch on fixes.
- Note the targeted room API in the release notes (the plugin targets the room's versioned HTTP API; pin the room commit it was tested against).
