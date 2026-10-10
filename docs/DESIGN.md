# Project Room design: rules and the October 2026 pass

Owner of this file: whoever changes the look. Keep it short; it is the
reference other agents check before touching colours, type, icons or public
pages.

## What competitors do (researched 7 Oct 2026)

- Linear: three theme inputs (base, accent, contrast), one accent used
  rarely, Inter, 13px body, 8px radius, borders not shadows. Agents get a
  small badge and "can never be mistaken for a person".
- Vercel Geist: every grey step has a job (3 backgrounds, 3 borders, 2 text
  levels). Radii 6 / 12 / 16. A single geometric mark.
- Discord: "people are circles, things are squircles".
- Slack, Notion: agents are @-mentioned like people and carry a quiet label.
- Buzz and ChatGPT Space publish almost nothing about their visuals.

Sources and the full notes: research report in the swarm paper workspace
(claude-github-door, 7 Oct).

## Rules

1. One accent, `--blue-strong` #5555bd: primary buttons, focus, selection,
   unread. Accent-coloured text uses `--blue` (#a9b9ff dark, #33339a light).
2. Greys come from `src/design-tokens.js` (pages embed DARK_DECLARATIONS). Do not add
   new greys; reuse `--bg --panel --panel-raised --panel-hover --line --muted
   --text`.
3. Borders separate surfaces. Shadows only on menus and dialogs.
4. Inter for everything. Weights 400 and 600 only on public pages.
   Headlines get negative letter-spacing (-0.02 to -0.04em).
5. Radius: `--radius-md` on controls, `--radius-lg` on cards and dialogs,
   full circle for human avatars, rounded square for agent avatars (already
   in the app: `.message-avatar.agent`).
6. Humans are circles, agents are rounded squares. The mark is those two
   shapes side by side.
7. Copy is as short as the job needs. No illustrations; the product is the
   picture.
8. Every public page (about, docs, compare, 404, offline) uses the same
   tokens and shows the mark + "Project Room" linking home.

## The mark

A green wireframe cube on black. Each face carries a 3x3 grid drawn in
dashes, like characters on a terminal, and one cell on top is lit: one room
in the grid. Green #3dff8b, tile black with a faint top lift (#0a0d0b to
#000000).

One drawing cannot work at 1024 px and 16 px, so there are three:
- large (128 px and up): dashed grid, soft glow, lit cell
- medium (49 to 127 px): solid grid, heavier edges, lit cell, no glow
- small (48 px and down): heavy edges and shaded faces only

`scripts/build-desktop-icon.mjs` is the source for all of them, in three
tile modes: `mac` (macOS 11 template: 824 tile on 1024, radius 185),
`square` (tile fills the canvas: favicon, web icons, lockups) and `bleed`
(square, for maskable and Apple touch icons that the OS rounds).
`scripts/build-brand-assets.mjs` uses it for the web; `brand/mark-mono.svg`
is a one-colour outline for inline use.

Rejected along the way: a doorway (read as a tombstone), overlapping
circle and square (read as a face), person and agent side by side (fine
but forgettable), an inside-of-a-room view (reads as a cube anyway, with
less clarity), letters (blur at 16 px).

The UI accent stays violet. Green in the UI already means "passed" or
"online"; a green accent would blur that signal.

## Assets in this pass

| File | Size | Notes |
|---|---|---|
| favicon.svg, icon.svg | 1024 grid | small cube drawing, square tile |
| brand/mark-mono.svg | 32 grid | cube outline, currentColor |
| icons/icon-192.png, icon-512.png | 192, 512 | cube on a rounded black tile |
| icons/maskable-512.png | 512 | black, cube inside the 80% safe zone |
| icons/apple-touch-icon-180.png | 180 | black square, cube centered (iOS rounds it) |
| og/home, about, offers, compare, receipts .png | 1200x630 | #202127, mark + wordmark top left, headline and one line in Inter, no background art |

Generator: `scripts/build-brand-assets.mjs` (Playwright, already a dev
dependency) renders every PNG from the SVG and HTML templates in one run, so
the next change is one edit and one command.

## Where it shows

- App top bar: the "PR" text tile becomes the mark.
- Sign-in and the no-JS hero: unchanged. John wants the PROJECT ROOM wordmark and a minimal entrance there.
- 404: styled with the public tokens, mark, two links.
- about.html: mark + name as the home link at the top.

Not in this pass (busy files with open PRs): `src/styles.css` beyond the
brand tile, `server/discoverability.mjs` (/agents, /receipts), compare pages.
