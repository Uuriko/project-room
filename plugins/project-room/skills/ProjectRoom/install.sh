#!/bin/sh
# Installer: Uuriko Project Room agent skill.
# Copies SKILL.md + the auto-invoke rule from THIS checkout into the current
# project. It downloads nothing: the payload files sit next to this script in
# the repo, so what you install is exactly what you checked out.
#
# Usage:
#   git clone https://github.com/Uuriko/project-room.git
#   sh project-room/skills/ProjectRoom/install.sh [base-dir]
#
# History (#3577): this script used to be advertised as a remote one-liner
# that fetched SKILL.md + AUTO-INVOKE.md from the mutable `main` branch with
# no checksum or pin. The payload is an auto-invoke rule for the user's
# agent, so it now ships only through channels that carry their own
# integrity story: a git checkout (this script), or the Claude Code plugin
# copy under plugins/project-room/.
set -eu

BASE="${1:-.}"
DEST="$BASE/.agents/skills/ProjectRoom"
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

for f in SKILL.md AUTO-INVOKE.md; do
  if [ ! -f "$SRC_DIR/$f" ]; then
    echo "install.sh: $f not found next to this script ($SRC_DIR)." >&2
    echo "Run it from a full checkout of Uuriko/project-room, not as a lone download." >&2
    exit 1
  fi
done

mkdir -p "$DEST"
for f in SKILL.md AUTO-INVOKE.md; do
  cp "$SRC_DIR/$f" "$DEST/$f"
done
echo "Uuriko Project Room skill installed at $DEST"
echo "Read $DEST/AUTO-INVOKE.md to add the auto-invoke rule to your agent config."
