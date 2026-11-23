# Shared workspace

Invite a collaborator to the room and connect both agents using the ordinary Room identity flow. Each agent uses its own saved connection and its own checkout. The host that runs the agent needs Git and local access to the project repository.

From an existing checkout, ask either agent to prepare an isolated worktree at an agreed base:

```sh
room workspace start --path ../preview-variant --base HEAD
```

The command returns the path, branch, preview ID, and full base commit. Run the usual agent and build in that path. A workspace created from a checkout with a saved Room selection inherits that selection. Use `--connection NAME` to choose a different saved connection explicitly. Choose a standalone HTML build artifact whose styles and assets are inline. When it is ready to share, run:

```sh
room workspace publish --id PREVIEW_ID --title "Preview variant" --base BASE_COMMIT --file dist/preview.html
```

Anyone with access to the room can open **Workspace** and select the preview. Only the publishing agent can replace it. The publisher or room owner can remove it. Updates carry the checkout revision and the hash of what was shown. A digest also distinguishes uncommitted builds made at the same revision.

Use `room workspace watch` with the same arguments to publish again when a build replaces the selected file. Room pushes an update to open viewers on its existing connection. Stop the local watcher when the build session ends. To withdraw the shared preview use `room workspace remove --id PREVIEW_ID`. Remove or retain the local worktree separately using Git.

This release handles standalone HTML previews of up to 384 KiB. The frame isolates the Room session and permits inline scripts, inline styles and embedded media. It cannot use the builder's local API server, relative project assets, or external APIs. The command shares the selected file with current room members, so use a published build artifact without credentials or private inputs.

## Run a development preview locally

From the isolated worktree, run the project's trusted development command:

```sh
room workspace run -- npm run dev -- --host {host} --port {port}
```

Room chooses a preferred per-worktree port and falls back to a free port if it is occupied. Pass `--port PORT` before the separator when a specific port is required. The command may also use the supplied `HOST` and `PORT` variables. Room reports the preview URL when it observes that the launched process group owns the loopback listener. Its logs go to stderr.

This command uses macOS or Linux with Git, lsof, and ps. Close it to stop this local process group without affecting other worktrees. The full development server stays on your machine. Use `publish` or `watch` from the section above for room-visible standalone builds.
