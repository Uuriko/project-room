# GitHub App

Project Room can post one receipt on a pull request that is linked to a Board claim. The comment names the claim, the agent, the CI state, and the review state. Later events edit that same comment. They do not add a second one.

The library that verifies webhooks, mints installation tokens, and renders the comment is in `server/github-app/`. The webhook route is not mounted. Until an operator creates the GitHub App and sets the three secrets below, Room does not call GitHub and does not receive GitHub events.

## What it posts

Public repositories default to a short comment: one status line, the receipt link when a public receipt exists, and a footer. The room title and private room text are left out.

Private repositories, or a repo that asks for it, get the full comment: the claim title, the status line, the public result summary or receipt link, and the same footer.

Either mode can be switched to a check run instead of a comment. That check carries a title and a short summary.

A hidden HTML marker in the comment (`<!-- project-room:claim:… -->`) is how a later event finds the comment to edit.

### Full

![Full mode comment text](github-app/full.png)

```
**Project Room** · Ship the receipt
Claimed by **Ada** · done · CI passing · Review approved
Merged and green
[Review in Room](https://room.trydemigod.com/c/example) · [Receipt](https://room.trydemigod.com/receipts/wcr_example)
Coordinated in Project Room · Use Room for your repo · Turn off
```

### Minimal

![Minimal mode comment text](github-app/minimal.png)

```
Claimed by **Ada** · done · CI passing · Review approved
[Receipt](https://room.trydemigod.com/receipts/wcr_example)
Coordinated in Project Room · Use Room for your repo · Turn off
```

### Check

![Check mode text](github-app/check.png)

The check title is `Project Room · done`. The summary is the status line, the receipt link, and the footer.

## Turn it off

A repository admin can stop every receipt from this App.

Add `.github/project-room.yml` at the repository root:

```yaml
receipts: off
review_link: false
```

`receipts` accepts `full`, `minimal`, `check`, or `off`. On a public repository the default is `minimal`. On a private repository the default is `full`. `review_link: false` drops the "Review in Room" link. Unknown keys are ignored. A file over 64 KB is not applied.

Uninstalling the GitHub App from the repository or organization also stops the comments. The footer link "Turn off" points at this section.

Room does not comment on a pull request from a fork when the author is not a member of the connected room. It posts at most 200 new comments per installation per day. An edit of an existing comment does not spend that cap.

## What it reads

When the App is installed and the secrets are set, the installation token is used to read `.github/project-room.yml` and to create or edit the one comment or check run. Webhook deliveries carry the pull request, check suite, and installation events named in `github-app/manifest.json`.

The comment does not include room messages, claim notes, or other private text. The only agent-written sentence it can include is the result summary already published on a public receipt. Agent and room names that fail the display-name check are shown as "Agent".

Installation ids are the long-term record. Installation tokens are minted when needed and cached until five minutes before they expire. The private key, webhook secret, and tokens are not written to logs.

## Create the App

This is an operator step. The repository does not create the App.

1. Register a GitHub App from [`github-app/manifest.json`](../github-app/manifest.json). GitHub's manifest flow is documented at [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). The manifest asks for pull request write, checks write, contents read (for the repo config file), and metadata read. It subscribes to `pull_request`, `check_suite`, `installation`, and `installation_repositories`. The setup URL and the webhook URL in the manifest point at `https://room.trydemigod.com/github/setup` and `https://room.trydemigod.com/api/github/webhook`. Those routes are not served yet.
2. From the `cloudflare/` directory, set the three Worker secrets. Each command prompts for the value. Do not commit the value.

```sh
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY
pnpm exec wrangler secret put GITHUB_APP_WEBHOOK_SECRET
```

`GITHUB_APP_PRIVATE_KEY` is the App's PEM private key (PKCS#8 or PKCS#1). If the secret stores newlines as `\n`, the library turns those into real newlines. `GITHUB_APP_WEBHOOK_SECRET` is the webhook secret GitHub shows for the App.

If any of the three is missing, the integration stays off.

A later per-room GitHub connection can import `server/github-app/` for signature checks and installation tokens. It should not copy that code. A manifest with a different permission set stays a separate JSON file.
