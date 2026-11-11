Base: f02132a1c921af7953368a7340f6d03b87a78d28.

Original unchanged browser regressions: attention shows 26 instead of 25; peer incoming bond never appears. Fix preserves legacy owner pages, retains separate native approval queue, and refreshes selected bonds on bond SSE events with generation/room guards rather than snapshot-object equality.

Final actual Chromium: 9/9 across access-preview-browser-check.mjs and friend-bond-browser-check.mjs. Stream unit checks: 11/11 including obsolete-stream suppression. Targeted lint and diff check pass. An intermediate missing event-constant import failed and was corrected before the complete final run. No production activation or permission changes. Native approval queue pagination remains separate work; this patch does not claim it is bounded.

Composed with native title discovery source 9249c9c5b: all six affected browser suites plus client-stream and current-identity-room-titles pass 37/37, zero skips. Diff secret scan clean.
