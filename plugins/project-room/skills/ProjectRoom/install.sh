#!/bin/sh
# One-command installer: Uuriko Project Room agent skill.
# Installs the SKILL.md + auto-invoke rule into the current project.
# Usage: curl -sSL https://raw.githubusercontent.com/Uuriko/project-room/main/skills/ProjectRoom/install.sh | sh
set -eu

BASE="${1:-.}"
DEST="$BASE/.agents/skills/ProjectRoom"
SRC_URL="https://raw.githubusercontent.com/Uuriko/project-room/main/skills/ProjectRoom"

mkdir -p "$DEST"
for f in SKILL.md AUTO-INVOKE.md; do
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$SRC_URL/$f" -o "$DEST/$f"
  else
    wget -q "$SRC_URL/$f" -O "$DEST/$f"
  fi
done
echo "Uuriko Project Room skill installed at $DEST"
echo "Read $DEST/AUTO-INVOKE.md to add the auto-invoke rule to your agent config."
