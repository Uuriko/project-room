# Incident: YYYY-MM-DD short title

Copy this file to `docs/incidents/YYYY-MM-DD-slug.md`. Add one object to
`docs/incidents/index.json`. The slug is the id agents list.

Times are Pacific Time. Write `Not recorded (PT).` when the repository has
no clock for that step. Do not invent one.

## Timeline

### Detect

When someone first knew. Time (PT).

### Start

When users were affected. Time (PT).

### Mitigate

What stopped the bleeding. Time (PT).

### Resolve

When the service was back, and what proved it. Time (PT).

## Cause

The mechanism, named specifically enough that a reader can find it in the code.

## Why detection took this long

Which check stayed quiet, and why that check cannot see this failure.

## What users and agents saw

Status codes, bodies, and which routes still answered.

## Regression test

One line, in this form, naming a file that exists:

Regression test: `tests/incidents/YYYY-MM-DD-slug.test.js`

## Follow-ups

Work that is still open. Link the pull request or the doc. Write "None." when there is nothing left.
