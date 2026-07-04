# PRD: Galley — Editing & Formatting

**Status:** Draft (split from the main PRD v11, 2026-07-04)
**Companion to:** [`docs/PRD.md`](PRD.md) — the main Galley PRD. This sub-PRD holds the detailed **editing**, **formatting-shortcut**, and **document-state** requirements; the main PRD's **§5 Features** section indexes it. Requirement IDs (**R#**) are unchanged by the split.

---

## 1. Editing

- **R16.** Edit the markdown **source** directly in-app.
- **R17.** **Live preview**: the rendered view updates as the user types.
- **R18.** **Scroll synchronization:** the preview tracks the editor's scroll position (and vice versa where natural) so the two panes stay aligned, particularly on long documents.
- **R19.** **Syntax highlighting** in the editor — **colour only**. The source pane stays uniform monospace (no bold/italic/enlarged-heading rendering); colour conveys structure the way a code editor highlights syntax, keeping the editor clearly *source* rather than a second rendered view.
- **R20.** **Undo / redo** support. Undo `Ctrl/Cmd+Z`; redo `Ctrl/Cmd+Y` **and** `Ctrl/Cmd+Shift+Z` (both bound).
- **R21.** **Find and replace** within the current document, via the editor's search panel (opened with `Cmd/Ctrl+F`). The built-in feature set: incremental find with match highlighting, find next / previous, replace and replace-all, and toggles for **case-sensitive**, **whole-word**, and **regular-expression** matching. *(Provided by CodeMirror's search extension out of the box; a frequently used operation, especially in larger files. The toggle set is the component's default — captured here for completeness, not separately required.)*
- **R22.** **Line numbers** — nice-to-have, optional. *(Typically free from the editor component.)*

## 2. Formatting shortcuts

Keyboard shortcuts that apply markdown formatting to the editor selection, so the user does not have to type or remember the syntax.

- **R23.** Provide keyboard shortcuts for the following formatting actions:

  | Action | Shortcut (macOS / Windows) | Markdown produced |
  |---|---|---|
  | Bold | `Cmd+B` / `Ctrl+B` | `**…**` |
  | Italic | `Cmd+I` / `Ctrl+I` | `_…_` (underscores — distinct from `**bold**`, and no accidental intra-word italics) |
  | Link | `Cmd+K` / `Ctrl+K` | `[…](…)` via dialog (see R27) |
  | Inline code | `Cmd+E` / `Ctrl+E` | `` `…` `` |
  | Strikethrough | `Cmd+Shift+X` / `Ctrl+Shift+X` | `~~…~~` |
  | Heading | `Cmd+1`…`Cmd+6` / `Ctrl+1`…`Ctrl+6` | line prefixed `#`…`######` |
  | Code block (fenced) | `Cmd+Shift+C` / `Ctrl+Shift+C` | wrap in ```` ``` ```` fences |
  | Indent list item | `Tab` | increases list nesting |
  | Outdent list item | `Shift+Tab` | decreases list nesting |

- **R24. Toggle behavior.** Each wrapping shortcut (bold, italic, inline code, strikethrough, code block) **toggles**: if the selection is already wrapped in that marker, the shortcut removes it rather than adding another layer.
  - **A bare cursor inside an existing span counts too.** With no selection but the cursor *within* a span of that type (e.g. `**Hello|world**` + bold), the shortcut removes the whole span instead of inserting a new empty pair. The span is found via the editor's Lezer syntax tree (the parser runs GFM, so strikethrough/tables/task-lists are recognized).
  - **Headings normalize to the requested level** rather than stacking. Applying a heading sets the line to exactly that level no matter its current level, and applying the line's *current* level removes the heading. Examples: `## Hello` + `Ctrl+4` → `#### Hello` (switches level, does **not** become `######`); `## Hello` + `Ctrl+2` → `Hello` (same level removes).

- **R25. Smart selection handling.** Each wrapping/prefixing shortcut behaves correctly with and without an active selection:
  - **Selection present** → wrap (or prefix, for headings/lists) the selected text.
  - **No selection** → insert the markers and place the cursor between them (e.g. `**|**`) so the user can type immediately.
  - *(Link is the exception — it always uses the dialog in R27.)*

- **R26. Indent / outdent.**
  - On a **list line**, `Tab` / `Shift+Tab` nest / un-nest the whole item from **anywhere on the line** — not just at the start. Nesting aligns the item with its parent's **CommonMark content column** (3 spaces under `1. `, 2 under `- `, 4 under `10. `), so nested lists actually render as nested rather than flattening or merging; un-nesting drops back to the parent item's column. The list marker is left untouched (numbered items keep their marker; the renderer numbers them — see R26a). The cursor stays on the same character.
  - On any **other line**, `Tab` inserts indentation at the cursor and `Shift+Tab` outdents the line. `Tab` never moves focus out of the editor.
  - Indentation uses **spaces, not hard tab characters**, at the width set in R28.
- **R26a. Lazy ordered-list numbering.** Galley never renumbers ordered lists; markers are left exactly as authored. The convention is **`1.` on every item**: because re-nesting or reordering never forces a renumber and the renderer shows the correct sequence, editing stays cheap.
- **R26b. List continuation.** `Enter` on a non-empty list item starts a new item on the next line with the same indentation and marker — **ordered markers as `1.`** (per R26a), bullets unchanged. `Enter` on an **empty** item ends the list (clears the marker). Off a list line, `Enter` is an ordinary newline.

- **R27. Link dialog.** `Cmd/Ctrl+K` opens a small dialog rather than inserting raw syntax, so the user never has to remember `[text](url)` ordering. Behavior:
  - **Two labeled fields:** **Text** and **URL**. Focus starts in the **URL** field.
  - **Creating a link:**
    - If text is selected, prefill **Text** with the selection; on confirm, insert `[text](url)` replacing the selection.
    - If nothing is selected, both fields start empty; on confirm, insert `[text](url)` at the cursor.
  - **Editing an existing link:** if the cursor is anywhere within an existing markdown link (any part of its `[text](url)` syntax), the dialog opens **prefilled** with that link's current Text and URL, and confirming updates the existing link in place.
  - **Remove-link button:** in edit mode, a **Remove link** action strips the link syntax and keeps the plain text (`[text](url)` → `text`).
  - *Nice-to-have (future):* if the clipboard contains a URL when the dialog opens, prefill the **URL** field with it.

- **R28. Indentation setting.** The editor indents with **spaces**, default width **2**. (Applies to R26 list nesting and general `Tab` indentation.)

> Status (2026-06-20): R23–R28 implemented. The wrap/heading/fence rules live in the pure, unit-tested `src/renderer/components/editorCommands.ts`; the keymap is registered at **highest precedence** so it wins over CodeMirror defaults (no clash found on `Cmd/Ctrl+E` or `K`). The link dialog reads/writes through the editor handle, using the Lezer syntax tree to detect an existing link at the cursor. Clipboard-URL prefill (R27 nice-to-have) remains future.

> Implementation note: CodeMirror 6 exposes keybindings via its keymap system, and wrap/toggle logic operates on selection ranges; existing markdown-command helpers cover much of R24–R25. The link dialog (R27) is a small renderer-side popover reading/writing the editor selection; detecting "cursor within a link" uses the markdown syntax tree (Lezer) CodeMirror already maintains.

## 3. Document states

The editor tracks **what it is showing as an explicit state**, not as a null-path heuristic. Two kinds exist today (a third, `untitled`, arrives with Save As):

- **Welcome screen** — a built-in **sandbox** shown whenever no file is open. It introduces the app and lets the user play with the renderer. It is **never saved** (no auto-save, no watcher, no Save), the title bar reads **"Welcome!"**, and it makes no claim to be a file. Opening a file replaces it.
- **File** — a document opened from disk, with a path, baseline hash, watcher, and the full save/auto-save/conflict behavior (R29–R36).
- **Untitled** *(future, with Save As)* — an editable buffer with **no destination yet**. Unlike the welcome screen it holds the user's work: auto-save and watching can't run, but unsaved changes must be surfaced and the user offered a way to save (Save As). *Not implemented yet — do not treat the welcome screen as an unsaved buffer.*
