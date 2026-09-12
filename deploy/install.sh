#!/usr/bin/env bash
# Install the Project Room systemd units with the hardcoded paths
# replaced by your own values. Run as root.
#
#   sudo ./deploy/install.sh --user room --group room \
#     --dir /opt/project-room/current --env /etc/project-room/pilot.env
#
# What it does:
#   1. Creates the service user/group if missing (or use --no-create-user).
#   2. Renders deploy/project-room.service and deploy/project-room-backup.service
#      with your user/group/dir/env substituted.
#   3. Installs them to /etc/systemd/system, reloads, enables and starts.
#
# The .service files in this repo stay as documented examples; the rendered
# units on disk carry your values. Re-run after changing any flag.
set -euo pipefail

USER_NAME="project-room"
GROUP_NAME="project-room"
APP_DIR="/opt/project-room/current"
ENV_FILE="/etc/project-room/pilot.env"
CREATE_USER=1

usage() {
  cat <<'EOF'
Usage: install.sh [--user NAME] [--group NAME] [--dir PATH] [--env PATH] [--no-create-user]
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_NAME="$2"; shift 2;;
    --group) GROUP_NAME="$2"; shift 2;;
    --dir) APP_DIR="$2"; shift 2;;
    --env) ENV_FILE="$2"; shift 2;;
    --no-create-user) CREATE_USER=0; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown flag: $1" >&2; usage >&2; exit 2;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo)." >&2; exit 1;
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$CREATE_USER" -eq 1 ] && ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
  echo "Created user $USER_NAME."
fi
if ! getent group "$GROUP_NAME" >/dev/null 2>&1; then
  groupadd --system "$GROUP_NAME"
fi

render() {
  sed -e "s|^User=.*|User=${USER_NAME}|" \
      -e "s|^Group=.*|Group=${GROUP_NAME}|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=${APP_DIR}|" \
      -e "s|^EnvironmentFile=.*|EnvironmentFile=${ENV_FILE}|" \
      -e "s|/opt/project-room/current|${APP_DIR}|g" \
      "$1"
}

for unit in project-room.service project-room-backup.service; do
  render "$SCRIPT_DIR/$unit" > "/etc/systemd/system/$unit"
  echo "Installed /etc/systemd/system/$unit."
done

systemctl daemon-reload
systemctl enable --now project-room.service
systemctl enable project-room-backup.timer
echo "Done. Check: systemctl status project-room.service"
