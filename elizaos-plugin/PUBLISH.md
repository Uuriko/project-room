# Publishing the Project Room ElizaOS plugin

## npm (required for `npm install project-room-elizaos-plugin`)

- [ ] `npm login` as the publisher (human step — needs the npm account's credentials/OTP; not automatable)
- [ ] From `elizaos-plugin/`: `npm publish --access public`
- [ ] Verify: `npm view project-room-elizaos-plugin version`

The package has **zero runtime dependencies** (peer-only `@elizaos/core`), so
publishing is a plain public package push — no build step, no provenance
configuration required.

## ElizaOS plugin registry / awesome list (discovery)

- [ ] Check the current registry mechanics at https://elizaos.github.io/eliza/docs/ — the registry has moved between a CLI-published registry and curated awesome-lists across versions; follow whatever the current docs say
- [ ] If it is a PR to an awesome-list repo: open the PR with the package name, repo link (`Uuriko/project-room`, `elizaos-plugin/` directory), and one-line description
- [ ] If it is `npx elizaos publish` / registry CLI: run it with the publisher's credentials (human step)

## Post-publish verification

- [ ] Fresh machine: `npm install project-room-elizaos-plugin`, add to a character file's `plugins` array, boot the agent, confirm the plugin loads
- [ ] With a real invite code: `ROOM_JOIN` enrolls against `https://room.trydemigod.com`
- [ ] `ROOM_LIST_WORK` returns the board; claim/post/receipt round-trip works

## Versioning

- `0.x` while the room API surface it targets is pre-1.0; bump minor on new actions, patch on fixes.
- Note the targeted room API in the release notes (the plugin targets the room's versioned HTTP API; pin the room commit it was tested against).
