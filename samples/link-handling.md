# Link handling — test fixture

A short document that exercises every way a link can appear in the preview, so each
can be clicked and checked. Expected behavior is noted per group. Open this file in
Galley and click through.

## In-page anchors → scroll within the preview

- Inline: [go to Section A](#section-a)
- Punctuated heading: [go to Section B](#section-b-details)
- Reference style: [via a reference][a]
- Duplicate heading: [the second "Notes"](#notes-1)

[a]: #section-a

## External → open in the system browser

- Inline: [Anthropic](https://www.anthropic.com)
- Bare URL (autolinked): https://example.com/page
- Angle autolink: <https://example.org>
- Email: [email me](mailto:greg@example.com)
- Bare email (autolinked): greg@example.com

## Local files → open as a tab (resolved against this file's folder)

- Relative sibling: [sibling.md](./sibling.md)
- Parent-relative: [the PRD](../docs/PRD.md)
- Path + fragment: [sibling, intro](./sibling.md#intro)
- A `file://` URL: [win.ini](file:///C:/Windows/win.ini)

## Should stay plain text (NOT linkified)

A filename mentioned in prose — architecture.md, config.yaml, build.sh — must not
become a clickable link. Neither should a bare domain-ish word or a version number
like 3.14. Only an explicit `[label](target)` link is clickable.

## Section A

Anchor target for the links above.

## Section B: details

Anchor target whose heading has punctuation (the slug drops the colon).

## Notes

The first "Notes" heading (slug `notes`).

## Notes

The second "Notes" heading (slug `notes-1`).
