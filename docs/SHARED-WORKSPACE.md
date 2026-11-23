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

If the checkout succeeded but its response was lost, repeat the same `start`
or `continue` command with the same path and source. Room verifies the saved
checkout and returns its original receipt without starting another one. For
Room-linked commands it also rechecks the current revision and member. If the
path cannot be verified, inspect it before choosing a new one.
When the same publisher replaces an artifact, a stale continuation can
return the currently visible link. Inspect that commit before running a new
continuation. The refusal does not create a checkout or choose it for you.

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
short-lived grant for one exact publication over TLS 1.3.

Publishers on other computers connect to the TLS passthrough address you
provide. For example, route TCP port 8443 on `preview-host.example` to the
Room machine's `127.0.0.1:8444` broker listener without terminating TLS at the
proxy. [HAProxy's TCP setup](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/tcp/)
is one way to wire it. Use a broker certificate with a DNS subject alternative
name for the exact hostname publishers dial. Use either a publicly trusted
certificate and chain, or give publishers your private CA certificate for
`--publisher-ca`. For an isolated trial with a self-signed certificate, run
this in a private directory, replacing the example hostname with yours:

```sh
openssl req -x509 -newkey rsa:3072 -nodes -days 30 \
  -subj '/CN=preview-host.example' -addext 'subjectAltName=DNS:preview-host.example' \
  -keyout publisher-key.pem -out publisher-cert.pem
```

Keep the key on the Room host. Give publishers only `publisher-cert.pem`
as their `--publisher-ca` file. A hostname mismatch or an untrusted
certificate stops registration.

Set `ROOM_WORKSPACE_PUBLISHER_ADDRESS=tls://preview-host.example:8443` on the
Room server so it supplies that address with the grant. To share a running app,
publish a directed snapshot and pass its preview link to the launcher:

```sh
room workspace run --live "$PREVIEW_LINK" -- npm run dev -- --host {host} --port {port}
```

With a private CA, add `--publisher-ca FILE` before the separator and use
the certificate file from the broker setup.
If the Room has no advertised address, add `--publisher tls://HOST:PORT` using
the address from your Room operator.

The command checks the link against the local commit and the current Room
publication, starts the app on its owned loopback port, and registers that
exact publication. Give your teammate the same Room link.
Stopping the command closes the live view. Withdrawing the publication
also closes it and leaves the local process available to the publisher.

To enable recipient live viewing, set `ROOM_WORKSPACE_VIEWER_ORIGIN` to a
separate HTTPS origin and `ROOM_WORKSPACE_VIEWER_PORT` to a third, unused
local port. Route wildcard DNS and TLS for the viewer domain to that
loopback listener and preserve the HTTP Host, Origin and WebSocket upgrade.
Use a dedicated domain for previews. Each live session uses a different
hostname, a one-use handoff and its own host-only cookie. A publisher and
the named recipient can use **Open live preview** when the exact directed
publication has a registered publisher. The live page forwards GET/HEAD
and the supported development-server hot reload connections. The saved
preview is available separately.

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
