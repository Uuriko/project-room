# Mac distribution

`build.sh` makes an ad-hoc signed **development** app. Public distribution uses
`distribute.mjs` and never falls back to development signing.

Prerequisites: a clean, CI-qualified checkout at a full commit SHA; macOS build
tools; a valid Developer ID Application certificate already installed in Keychain;
and an existing notarytool Keychain profile. Do not pass passwords or API keys in
arguments, commit them, or copy a personal Keychain into a build workspace.

From the repository root, run with explicit values:

```sh
node desktop/macos/distribute.mjs \
  --revision FULL_40_CHARACTER_COMMIT_SHA \
  --version 1.0.0 \
  --identity CERTIFICATE_SHA1_FINGERPRINT \
  --notary-profile CONFIGURED_KEYCHAIN_PROFILE \
  --output /absolute/new/release-directory
```

This is an actual signing and notarization operation, not a dry run. It verifies
source and identity before building, checks source provenance again, signs the
helper and app with hardened runtime and timestamping, submits a ZIP to Apple,
requires Accepted, staples and validates the ticket, checks signatures and
Gatekeeper, and creates the final ZIP plus SHA256/source/version receipt. Existing
output directories are refused. A failed run may leave diagnostic/intermediate
artifacts; absence of a successful receipt means they are not a release.

Publish only the final versioned ZIP and release receipt after checking the
supported-machine installation and launch journey. Do not publish the intermediate
notary-submission ZIP. The archive is built for the current architecture, recorded
in the receipt; this is not a universal binary claim. The receipt excludes signing
identity and Keychain profile. Keep source and release checks alongside the receipt.

First-version updates use a signed manual replacement: quit Project Room, verify
and install the newer notarized release, then reopen. Qualify retained account and
draft state before publishing an update. Automatic updates are not implemented.
Do not suggest disabling Gatekeeper to install a public release.

On 2026-10-18 this development Mac had zero valid signing identities. Pipeline
validation is not notarization evidence. Public Mac release remains blocked until
an authorized configured identity/profile is available and a real artifact passes.

References: [Apple Developer ID](https://developer.apple.com/developer-id/) and
[notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
