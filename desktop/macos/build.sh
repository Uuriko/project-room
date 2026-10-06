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
codesign --force --sign - "$app/Contents/MacOS/ProjectRoomTools"
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
codesign --force --sign - "$app"
printf 'Local app: %s\n' "$app"
printf 'Ad-hoc signed development build; distribution requires Developer ID and notarization.\n'
