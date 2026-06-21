# Link handling test fixture

A document that exercises every way a link can appear in the preview, so each can be
clicked and checked. Expected behavior is noted per group. Open this file in Galley
and click through. It is deliberately long enough to scroll, and every section has a
`↑ Back to top` link that jumps back here (an in-page anchor to this title).

The three behaviors to confirm:

1. **In-page anchors** (`#heading`) scroll within the preview — they never leave the app.
2. **External links** (an explicit `http(s)://` or `mailto:` scheme) open in the system browser.
3. **Local-file links** (a relative/absolute path, or a `file://` URL) open as a new tab,
   resolved against this file's own folder.

A fourth thing to confirm is a *non-behavior*: bare text that merely looks like a link —
a filename mentioned in prose, a bare domain, a version number — must stay plain text.

## In-page anchors → scroll within the preview

[↑ Back to top](#link-handling-test-fixture)

These should move the reading position within this same document, smoothly, without
opening a browser or a new tab.

- Inline link: [go to Section A](#section-a)
- Punctuated heading: [go to Section B](#section-b-details)
- A heading far below: [jump to the Appendix](#appendix-filler-for-scrolling)
- Reference style: [via a reference][a]
- Duplicate heading: [the second "Notes"](#notes-1)

[a]: #section-a

Anchors are the most common cross-reference an LLM emits — a table of contents, a
"see the section above," a footnote-style back-link. They rely on each heading having a
stable `id` slug, generated the same way GitHub does it.

## External → open in the system browser

[↑ Back to top](#link-handling-test-fixture)

Each of these carries an explicit scheme, so it is unambiguously a web or mail address
and is handed to the operating system's default handler.

- Inline: [Anthropic](https://www.anthropic.com)
- Bare URL (autolinked): https://example.com/page
- Angle autolink: <https://example.org>
- Email: [email me](mailto:greg.esch@gmail.com)
- Bare email (autolinked): greg.esch@gmail.com

The renderer never navigates itself, so clicking one of these does not change what is
shown in the window — it only asks the OS to open the link elsewhere.

## Local files → open as a tab

[↑ Back to top](#link-handling-test-fixture)

These have no web scheme, so they are treated as file paths and opened as tabs. Each is
resolved relative to the folder this document lives in.

- Relative sibling: [sibling.md](./sibling.md)
- Parent-relative: [the PRD](../docs/PRD.md)
- Path + fragment: [sibling, the cavern](./sibling.md#the-cavern)
- A `file://` URL: [win.ini](file:///C:/Windows/win.ini)

Opening one should add a new tab and focus it. Re-clicking the same link should focus
the already-open tab rather than opening a duplicate.

## Should stay plain text (NOT linkified)

[↑ Back to top](#link-handling-test-fixture)

A filename mentioned in prose — architecture.md, config.yaml, build.sh — must not become
a clickable link. Neither should a bare domain-ish word, nor a version number like 3.14,
nor a ratio like 16.9. Only an explicit `[label](target)` link is clickable.

This matters because many file extensions are now real top-level domains (`.md` is
Moldova, and `.sh`, `.zip`, `.app`, `.dev` exist too), so "fuzzy" autolinking would wrongly
turn ordinary filenames in prose into web links.

## Section A

[↑ Back to top](#link-handling-test-fixture)

Anchor target for the links above. The surrounding paragraphs exist mainly to give the
document some height so that jumping between anchors visibly moves the viewport.

When you arrived here from an anchor link, this heading should be sitting at (or near)
the top of the reading pane.

## Section B: details

[↑ Back to top](#link-handling-test-fixture)

Anchor target whose heading contains punctuation. The colon is dropped when the slug is
computed, so the link target is `#section-b-details` even though the heading reads
"Section B: details".

This is the kind of heading an LLM commonly writes, so it is worth confirming the slug
matches what a hand-written cross-reference would guess.

## Notes

[↑ Back to top](#link-handling-test-fixture)

The first "Notes" heading. Its slug is `notes`.

## Notes

[↑ Back to top](#link-handling-test-fixture)

The second "Notes" heading. Because the slug `notes` is already taken, this one becomes
`notes-1`, mirroring GitHub's de-duplication. The "duplicate heading" link near the top
points here.

## Appendix: filler for scrolling

[↑ Back to top](#link-handling-test-fixture)

This appendix exists only to add height so the document scrolls comfortably and the
anchor jumps are obvious.

- One fish, two fish, a paragraph of filler to take up a line of vertical space.
- A second bullet, equally unremarkable, continuing to fill the page.
- A third, for good measure, so the list has some presence.

The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.
The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.

The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.
The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.

The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.
The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.

That should be enough vertical room. Use the `↑ Back to top` link below to return to the
title, which is itself an in-page anchor and a final thing to verify.

[↑ Back to top](#link-handling-test-fixture)
