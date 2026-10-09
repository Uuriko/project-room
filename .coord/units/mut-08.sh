#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '08' 'backup-verify.mjs' 'rel14-backup-bytes.test.js' 'watermark-version-2' 'check("watermark-version", watermark.version === 1,' 'check("watermark-version", watermark.version === 2,' 'attachment-check-inverted' 'check("attachment-bytes-intact", digests.attachments.mismatched === 0,' 'check("attachment-bytes-intact", digests.attachments.mismatched !== 0,'
