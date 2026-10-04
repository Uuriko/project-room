#!/usr/bin/env bash
# install.sh — turn an always-on machine into a Project Room "shed".
#
# A shed keeps one Project Room agent identity present while you are away:
# it polls your attention inbox on a timer and journals what needs you. With
# SHED_AGENT_CMD set, it hands actionable items to your own agent command.
#
# What this script does (nothing hidden):
#   1. Checks for Node >= 24.19.
#   2. Clones (or reuses) the project-room repo into the shed directory.
#   3. Validates your existing agent connection (it does NOT mint identities —
#      enroll first with the paste packet or quickstart, then point the shed at it).
#   4. Optionally installs Tailscale so you can reach this headless box securely.
#   5. Writes shed.env and installs a user-level systemd unit (Linux) or
#      launchd agent (macOS), then starts the loop.
#
# Usage:
#   ./install.sh [--dry-run] [--dir ~/.project-room/shed] [--repo-url ...]
#
# Re-running is safe: it never overwrites an existing connection.

set -euo pipefail

SHED_DIR="${SHED_DIR:-$HOME/.project-room/shed}"
REPO_URL="${REPO_URL:-https://github.com/Uuriko/project-room}"
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --dir) SHED_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --dir=*) SHED_DIR="${1#--dir=}"; shift ;;
    --repo-url) REPO_URL="${2:?--repo-url needs a value}"; shift 2 ;;
    --repo-url=*) REPO_URL="${1#--repo-url=}"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY_RUN" = 1 ]; then say "[dry-run] $*"; else eval "$*"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
case "$OS" in
  Linux) INIT="systemd" ;;
  Darwin) INIT="launchd" ;;
  *) say "unsupported OS: $OS (Linux and macOS only)"; exit 1 ;;
esac

# 1. Node check
if ! have node; then
  say "node not found. Install Node 24.19+ first: https://nodejs.org (or your package manager), then re-run."
  exit 1
fi
NODE_VER="$(node -p 'process.versions.node')"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(!(a>24||(a===24&&b>=19)))process.exit(1)'; then
  say "node $NODE_VER is too old; this repo needs >= 24.19.0. Upgrade node, then re-run."
  exit 1
fi
say "node $NODE_VER ok ($INIT)"

REPO_DIR="$SHED_DIR/repo"
ENV_FILE="$SHED_DIR/shed.env"
STATE_DIR="$SHED_DIR/state"

# 2. Repo
if [ -d "$REPO_DIR/.git" ]; then
  say "repo already present at $REPO_DIR"
  run "git -C '$REPO_DIR' pull --ff-only -q || true"
else
  if ! have git; then say "git not found; install git, then re-run."; exit 1; fi
  say "cloning $REPO_URL -> $REPO_DIR"
  run "git clone --depth 1 '$REPO_URL' '$REPO_DIR'"
fi
if [ ! -f "$REPO_DIR/shed/shed-loop.mjs" ]; then
  say "repo at $REPO_DIR has no shed/ directory; is REPO_URL correct?"
  exit 1
fi

# 3. Connection — validate, never mint here.
say ""
say "The shed needs your existing Project Room agent connection."
say "If you do not have one yet, enroll first, then re-run this installer:"
say "  - Paste docs/JOIN-ANY-AGENT.md into your AI, or"
say "  - Follow docs/AGENT-QUICKSTART.md, or redeem an invite link."
say ""
CONN_DIR="${ROOM_AGENT_CONFIG:-}"
if [ -z "$CONN_DIR" ]; then
  printf 'Connection directory (the folder holding connection.json): '
  read -r CONN_DIR
fi
if [ ! -f "$CONN_DIR/connection.json" ]; then
  say "no connection.json in $CONN_DIR. Enroll first (see above), then re-run."
  exit 1
fi
say "validating connection…"
if [ "$DRY_RUN" = 1 ]; then
  say "[dry-run] node -e checkConnection against $CONN_DIR"
else
  ROOM_AGENT_CONFIG="$CONN_DIR" node --input-type=module -e "
    import { agentConnectionFromEnvironment } from '$REPO_DIR/client/agent-connection.mjs';
    import { RoomAgentClient } from '$REPO_DIR/client/room-agent.mjs';
    const config = agentConnectionFromEnvironment();
    const status = await new RoomAgentClient(config).checkConnection();
    if (status.status !== 'credential_accepted') { console.error('rejected: ' + status.status); process.exit(1); }
    console.log('credential accepted for member ' + status.memberId + ' in room ' + config.roomId);
  "
fi

# 4. Tailscale (optional, explicit consent)
say ""
NEED_TS=0
if have tailscale && tailscale status >/dev/null 2>&1; then
  say "tailscale already up"
else
  printf 'Install/enable Tailscale so you can reach this box securely? [y/N] '
  read -r ans
  case "$ans" in [Yy]*) NEED_TS=1 ;; *) say "skipping tailscale (you can add it later: https://tailscale.com/download)" ;; esac
fi
if [ "$NEED_TS" = 1 ]; then
  if [ "$OS" = "Linux" ]; then
    say "installing tailscale via the official installer (requires sudo)"
    run "curl -fsSL https://tailscale.com/install.sh | sh"
    run "sudo tailscale up"
  else
    say "on macOS install Tailscale from the App Store, then run: tailscale up"
  fi
fi

# 5. Config + service
mkdir -p "$STATE_DIR"
chmod 700 "$SHED_DIR" "$STATE_DIR" 2>/dev/null || true
POLL_SECS="${SHED_POLL_SECS:-60}"
AGENT_CMD="${SHED_AGENT_CMD:-}"
if [ ! -f "$ENV_FILE" ] || [ "$DRY_RUN" = 1 ]; then
  say "writing $ENV_FILE"
  if [ "$DRY_RUN" = 1 ]; then say "[dry-run] write shed.env"; else
    cat > "$ENV_FILE" <<EOF
# Generated by shed/install.sh — edit freely, then restart the service.
ROOM_AGENT_CONFIG=$CONN_DIR
SHED_STATE_DIR=$STATE_DIR
SHED_POLL_SECS=$POLL_SECS
# Set SHED_AGENT_CMD to let the shed hand work to your own model CLI, e.g.:
# SHED_AGENT_CMD=claude -p --output-format json
SHED_AGENT_CMD=$AGENT_CMD
EOF
    chmod 600 "$ENV_FILE"
  fi
else
  say "keeping existing $ENV_FILE"
fi

if [ "$INIT" = "systemd" ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_FILE="$UNIT_DIR/project-room-shed.service"
  run "mkdir -p '$UNIT_DIR'"
  say "installing user systemd unit $UNIT_FILE"
  if [ "$DRY_RUN" = 1 ]; then say "[dry-run] render unit from template"; else
    sed -e "s|@ENV_FILE@|$ENV_FILE|" -e "s|@REPO_DIR@|$REPO_DIR|" \
      "$REPO_DIR/shed/project-room-shed.service" > "$UNIT_FILE"
  fi
  run "systemctl --user daemon-reload"
  run "systemctl --user enable --now project-room-shed.service"
  say ""
  say "done. status: systemctl --user status project-room-shed.service"
  say "journal: tail -f $STATE_DIR/attention.jsonl"
  say "heartbeat: cat $STATE_DIR/heartbeat.json"
else
  PLIST="$HOME/Library/LaunchAgents/com.project-room.shed.plist"
  run "mkdir -p '$HOME/Library/LaunchAgents'"
  say "installing launchd agent $PLIST"
  if [ "$DRY_RUN" = 1 ]; then say "[dry-run] render plist from template"; else
    sed -e "s|@NODE@|$(command -v node)|" -e "s|@LOOP@|$REPO_DIR/shed/shed-loop.mjs|" \
        -e "s|@CONN_DIR@|$CONN_DIR|" -e "s|@STATE_DIR@|$STATE_DIR|" -e "s|@POLL@|$POLL_SECS|" \
        "$REPO_DIR/shed/com.project-room.shed.plist" > "$PLIST"
  fi
  run "launchctl unload '$PLIST' 2>/dev/null || true"
  run "launchctl load '$PLIST'"
  say ""
  say "done. logs: tail -f $STATE_DIR/attention.jsonl"
fi

say ""
say "Your shed is polling every ${POLL_SECS}s. Close the laptop — the loop keeps going."
say "To let it hand work to your model, set SHED_AGENT_CMD in $ENV_FILE and restart."
