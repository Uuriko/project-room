#!/usr/bin/env bash
# ci-host-isolation-setup.sh — AppArmor setup for the bubblewrap sandbox in CI.
#
# Ubuntu 24.04 restricts unprivileged user namespaces via AppArmor
# (kernel.apparmor_restrict_unprivileged_userns=1); the bwrap launcher needs an
# application profile granting `userns`, or sandbox startup fails with
# "setting up uid map: Permission denied".
#
# Ubuntu 26.04 ships AND loads its own /etc/apparmor.d/bwrap-userns-restrict
# profile for /usr/bin/bwrap. Writing our own profile for the same path on
# 26.04 creates CONFLICTING ATTACHMENTS and prevents sandbox startup, so on
# 26.04 we only ensure the packaged profile is loaded and never write a
# custom one. Global AppArmor restrictions and --unshare-all stay intact on
# both releases.
#
# Branch selection (first match wins):
#   1. userns restriction off/absent        -> nothing to do
#   2. /etc/apparmor.d/bwrap-userns-restrict -> Ubuntu 26.04+: (re)load packaged profile
#   3. /etc/apparmor.d/bwrap                -> 24.04 runner image: reload distro profile
#   4. neither                              -> 24.04-era fallback: minimal custom profile
#
# Environment overrides (for local verification of branch selection):
#   BWRAP_RESTRICT_PROFILE, BWRAP_LEGACY_PROFILE, APPARMOR_PROFILES,
#   USERNS_SYSCTL, CI_SANDBOX_DRY_RUN=1 (print sudo actions, do not run them).
set -euo pipefail

BWRAP_RESTRICT_PROFILE="${BWRAP_RESTRICT_PROFILE:-/etc/apparmor.d/bwrap-userns-restrict}"
BWRAP_LEGACY_PROFILE="${BWRAP_LEGACY_PROFILE:-/etc/apparmor.d/bwrap}"
APPARMOR_PROFILES="${APPARMOR_PROFILES:-/sys/kernel/security/apparmor/profiles}"
USERNS_SYSCTL="${USERNS_SYSCTL:-/proc/sys/kernel/apparmor_restrict_unprivileged_userns}"
DRY_RUN="${CI_SANDBOX_DRY_RUN:-0}"

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'dry-run:'
    printf ' %s' "$@"
    printf '\n'
  else
    sudo "$@"
  fi
}

userns_restrict="$(cat "$USERNS_SYSCTL" 2>/dev/null || true)"
if [ "$userns_restrict" != "1" ]; then
  echo "ci-sandbox: kernel.apparmor_restrict_unprivileged_userns=${userns_restrict:-unset}; no AppArmor profile needed"
  exit 0
fi

if [ -f "$BWRAP_RESTRICT_PROFILE" ]; then
  # Ubuntu 26.04+: the distro owns this attachment. Never write a custom
  # profile for /usr/bin/bwrap here — it conflicts with the packaged one.
  if grep -q '^bwrap-userns-restrict ' "$APPARMOR_PROFILES" 2>/dev/null; then
    echo "ci-sandbox: packaged bwrap-userns-restrict profile already loaded; keeping it"
  else
    echo "ci-sandbox: loading packaged profile $BWRAP_RESTRICT_PROFILE"
    run apparmor_parser -r "$BWRAP_RESTRICT_PROFILE"
  fi
elif [ -f "$BWRAP_LEGACY_PROFILE" ]; then
  echo "ci-sandbox: reloading distro profile $BWRAP_LEGACY_PROFILE"
  run apparmor_parser -r "$BWRAP_LEGACY_PROFILE"
else
  # 24.04-era fallback: minimal custom profile scoped to distro bubblewrap.
  profile="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/project-room-bwrap.apparmor"
  cat > "$profile" <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
/usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
  echo "ci-sandbox: loading custom profile $profile"
  run apparmor_parser -r "$profile"
fi
