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

From an open Work Thread, open **Workspace** and choose **Copy start
instructions** to give a coding agent the same thread and a local setup
command. The agent can also run it directly:

```sh
room workspace start --from-work 'WORK_THREAD_URL' --path ../preview-variant --base HEAD
```

The CLI reads the selected work through the current Room connection before
creating the worktree, then returns the current brief and thread link. This
local attempt does not claim the task or post to the room. Publishing the
attempt prints the original thread link again so the publisher can open the
thread and return just the result they choose to share.

This release handles standalone HTML previews of up to 384 KiB. The frame isolates the Room session and permits inline scripts, inline styles and embedded media. It cannot use the builder's local API server, relative project assets, or external APIs. The command shares the selected file with current room members, so use a published build artifact without credentials or private inputs.

## Compare committed changes

Add `--include-changes yes` when publishing or watching a preview to share the committed changes between the supplied base and the current checkout head. The change summary excludes unstaged and untracked files. Members can open **Changes** beside the preview and compare a second attempt from the same base commit. The change view opens a file's hunks and has a raw fallback when a patch cannot be fully parsed.

Agents can get a compact file list with `room workspace changes --id PREVIEW_ID`, read one file with `--file PATH`, or retrieve the original patch with `--raw yes`. The patch stays attached to its exact source and preview revision.

## Keep the preview, changes, and run together

The Workspace opens available views for the selected attempt. Switch between Preview, Changes, and Run output without reopening the preview or losing the selected comparison. Use the arrows, Home, or End on the view tabs.

Add `--output dist/run.log` to publish or watch alongside the HTML and optional patch. Choose a shareable plain-text file up to 24 KiB. Agents can read it directly with `room workspace output --id PREVIEW_ID`. Room binds the output to its preview revision. A replacement preview with different HTML or source clears the old output unless the publisher supplies the new output with it.

## Share one artifact

Use **Copy artifact link** on Preview, Changes, or Run output. Paste it into the relevant Room conversation for a teammate. The link names the selected artifact revision, publisher, and content digest. It only opens for someone with access to this room. If that revision is replaced, the viewer gets an explicit choice to open the current attempt. When Changes is open, the link selects the primary attempt’s current file.
Agents can pass that link to `room workspace changes --link URL` to read the
exact file in one call.

To continue a teammate's attempt, use **Copy for agent** and paste the handoff
into your coding agent. It includes the selected source link, expected commit
and worktree command. For direct CLI usage, copy the artifact link:

```sh
room workspace continue --link 'ARTIFACT_URL' --path ../next-attempt
```

Room checks the link against the current shared artifact through your saved
connection. The command creates a new branch and worktree from the exact
published commit. When the commit is missing, add `--fetch-from origin` or
name another configured remote. Room fetches only the selected commit and
rechecks the artifact before creating the worktree. Private drafts, unpublished files, and run history stay
with the original workspace unless their author shares them.

## Run a development preview locally

From the isolated worktree, run the project's trusted development command:

```sh
room workspace run -- npm run dev -- --host {host} --port {port}
```

Room chooses a preferred per-worktree port and falls back to a free port if it is occupied. Pass `--port PORT` before the separator when a specific port is required. For a project inside a monorepo, pass its working directory before
the command separator, for example `room workspace run --cwd apps/web -- npm run dev`.
Use a directory within the same worktree. Port selection and relative run log
paths still use the worktree root. The command may also use the supplied `HOST` and `PORT` variables. Room reports the preview URL when it observes that the launched process group owns the loopback listener. Its logs go to stderr.

This command uses macOS or Linux with Git, lsof, and ps. Close it to stop this local process group without affecting other worktrees. The full development server stays on your machine. Use `publish` or `watch` from the section above for room-visible standalone builds.

The Node server can start an optional Workspace publisher broker on loopback.
Set `ROOM_WORKSPACE_PUBLISHER_PORT`, `ROOM_WORKSPACE_PUBLISHER_TLS_KEY` and
`ROOM_WORKSPACE_PUBLISHER_TLS_CERT` together. Use a different port from the
Room HTTP listener and absolute certificate paths. The broker accepts a
short-lived grant for one exact publication over TLS 1.3. It is an internal
publisher connection. A separate gateway with Room viewer authorization is
needed before a teammate can open a running app in their browser.

## Share an attempt with one teammate

Attach `--share-with MEMBER_ID` to `publish` or `watch` when an artifact
should go to one active Room member. Share the copied artifact link with that
person. The publisher and that exact member can open the preview, changes, and
run output through their usual Room access. Use `--include-changes yes` and
`--output` to include those artifacts when useful. The local agent session
stays private.

Keep the same member ID on updates and retries. To address another person or
share room-wide, start a new Workspace publication with a new preview ID.
`remove` withdraws the earlier publication.

Add `--log dist/run.log` before the separator to keep the latest 24 KiB of
combined output in a new local log file. The directory must already exist and
the file is private to your local user. Choose it later with `publish --output`
or `watch --output` when you want to share that output.

When you open Workspace from a Room thread or from a Work Thread with a visible
source discussion, choose **Add to thread draft** to bring the selected
room-wide artifact back to that discussion. Room preserves any text you already
typed. Review the draft and use Send when ready.
