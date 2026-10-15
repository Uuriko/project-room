# Channels contract

Project Room uses **channel** for a named conversation inside a workspace and **direct message (DM)** for a private conversation between exactly two distinct members. A room remains the authorization and event-stream boundary; Channels are navigation and search projections and do not weaken room access checks.

## A1/A2 directory

`channelDirectory(entries)` accepts external or stored entries, validates stable IDs and names, rejects duplicate IDs and unknown kinds, and emits deterministic records. Named channels sort before DMs, then by display name and ID. A named channel must name its workspace. A DM must contain exactly two distinct member IDs.

## A3 sidebar

`channelSidebar(entries, { selectedId })` derives the persistent navigation model. It exposes stable `channels` and `direct` sections, total unread count, and preserves selection only while that channel remains visible. Otherwise it selects the first visible entry. It contains no authorization bypass: callers supply only entries already authorized for the current member.

## A4 direct conversations

`directConversation(left, right)` canonicalizes the member pair and derives the same ID regardless of argument order. Self-DMs, missing members and oversized membership fail closed. Creation and message writes remain server commands and must perform their own room-member checks.

## A11 search modifiers

`parseChannelSearch(query)` recognizes `in:`, `from:`, `has:` and `is:` tokens. Recognized modifiers are removed from free text, repeated values are deduplicated in input order, and a missing value is rejected. Unknown `key:value` tokens stay in free text and are also returned in `unknown`; the parser never silently broadens an unsupported filter.

## Executable evidence

Run `node --test tests/channels.test.js`. The test vectors cover normalization, deterministic ordering, duplicate and vocabulary denial, stable sidebar selection, canonical DMs, self/oversized denial, modifier extraction, repetition, unknown tokens and missing values.
