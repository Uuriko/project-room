#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release --product ProjectRoom
swift build -c release --product ProjectRoomTools
app="$PWD/build/Project Room.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" build/ProjectRoom.iconset
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" ../../icons/icon-512.png --out "build/ProjectRoom.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" ../../icons/icon-512.png --out "build/ProjectRoom.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns build/ProjectRoom.iconset -o "$app/Contents/Resources/ProjectRoom.icns"
cp .build/release/ProjectRoom "$app/Contents/MacOS/ProjectRoom"
cp .build/release/ProjectRoomTools "$app/Contents/MacOS/ProjectRoomTools"
# Signing: ad-hoc by default (local development). For a public download set
# PROJECT_ROOM_SIGN_IDENTITY to a "Developer ID Application: … (TEAMID)" identity in
# the login keychain; optionally set PROJECT_ROOM_NOTARY_PROFILE to a
# `xcrun notarytool store-credentials` keychain profile to notarize and staple.
identity="${PROJECT_ROOM_SIGN_IDENTITY:--}"
notary_profile="${PROJECT_ROOM_NOTARY_PROFILE:-}"
sign_args=(--force --sign "$identity")
if [[ "$identity" != "-" ]]; then
  cat > build/ProjectRoom.entitlements <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.automation.apple-events</key><true/>
</dict></plist>
ENT
  sign_args+=(--options runtime --timestamp --entitlements build/ProjectRoom.entitlements)
elif [[ -n "$notary_profile" ]]; then
  printf 'PROJECT_ROOM_NOTARY_PROFILE needs PROJECT_ROOM_SIGN_IDENTITY (ad-hoc builds cannot be notarized).\n' >&2
  exit 1
fi
codesign "${sign_args[@]}" "$app/Contents/MacOS/ProjectRoomTools"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.trydemigod.projectroom</string>
<key>CFBundleName</key><string>Project Room</string>
<key>CFBundleDisplayName</key><string>Project Room</string>
<key>CFBundleExecutable</key><string>ProjectRoom</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>ProjectRoom</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>Project Room sign-in</string><key>CFBundleURLSchemes</key><array><string>projectroom</string></array></dict></array>
<key>NSAppleEventsUsageDescription</key><string>Project Room controls apps only for tasks you authorize.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
plutil -insert ProjectRoomSourceRevision -string "$(git rev-parse HEAD)" "$app/Contents/Info.plist"
source_dirty=false
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then source_dirty=true; fi
plutil -insert ProjectRoomSourceDirty -bool "$source_dirty" "$app/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$(git rev-list --count HEAD)" "$app/Contents/Info.plist"
codesign "${sign_args[@]}" "$app"
printf 'Local app: %s\n' "$app"
if [[ "$identity" == "-" ]]; then
  printf 'Ad-hoc signed development build; distribution requires Developer ID and notarization.\n'
  exit 0
fi
codesign --verify --deep --strict "$app"
zip="build/Project-Room-$(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")-$(git rev-parse --short=8 HEAD).zip"
rm -f "$zip"
if [[ -n "$notary_profile" ]]; then
  ditto -c -k --keepParent "$app" "$zip"
  xcrun notarytool submit "$zip" --keychain-profile "$notary_profile" --wait
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  rm -f "$zip"
  ditto -c -k --keepParent "$app" "$zip"
  printf 'Developer ID signed, notarized and stapled: %s\n' "$zip"
else
  ditto -c -k --keepParent "$app" "$zip"
  printf 'Developer ID signed, NOT notarized (set PROJECT_ROOM_NOTARY_PROFILE): %s\n' "$zip"
fi
