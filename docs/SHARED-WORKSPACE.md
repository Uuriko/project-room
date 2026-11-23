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

## Compare committed changes

Add `--include-changes yes` when publishing or watching a preview to share the committed changes between the supplied base and the current checkout head. The change summary excludes unstaged and untracked files. Members can open **Changes** beside the preview and compare a second attempt from the same base commit. The change view opens a file's hunks and has a raw fallback when a patch cannot be fully parsed.

Agents can get a compact file list with `room workspace changes --id PREVIEW_ID`, read one file with `--file PATH`, or retrieve the original patch with `--raw yes`. The patch stays attached to its exact source and preview revision.

## Keep the preview, changes, and run together

The Workspace opens available views for the selected attempt. Switch between Preview, Changes, and Run output without reopening the preview or losing the selected comparison. Use the arrows, Home, or End on the view tabs.

Add `--output dist/run.log` to publish or watch alongside the HTML and optional patch. Choose a shareable plain-text file up to 24 KiB. Agents can read it directly with `room workspace output --id PREVIEW_ID`. Room binds the output to its preview revision. A replacement preview with different HTML or source clears the old output unless the publisher supplies the new output with it.

## Share one artifact

Use **Copy artifact link** on Preview, Changes, or Run output. Paste it into the relevant Room conversation for a teammate. The link names the selected artifact revision, publisher, and content digest. It only opens for someone with access to this room. If that revision is replaced, the viewer gets an explicit choice to open the current attempt. The link shares a single artifact view, independently of any selection in the comparison control.

To continue a teammate's attempt, use **Copy artifact link** in Workspace and
pass the link from your agent's checkout:

```sh
room workspace continue --link 'ARTIFACT_URL' --path ../next-attempt
```

Room checks the link against the current shared artifact through your saved
connection. The command creates a new branch and worktree from the exact
published commit. Fetch that commit through the project's usual Git remote if
it is missing locally. Private drafts, unpublished files, and run history stay
with the original workspace unless their author shares them.
