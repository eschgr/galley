# PRD: Galley — Editing & Formatting

**Status:** Draft

---

## 1. Summary

Galley edits the markdown **source** directly, with live preview and synchronized scrolling. The editor is deliberately *source*: uniform monospace with colour-only highlighting, kept visually distinct from the rendered view the way a code editor is distinct from what it produces. Formatting shortcuts apply markdown to the selection — bold, italic, code, headings, lists, links — so the user never has to remember or type the syntax by hand. The editor tracks an explicit **document-state** model for what it is showing rather than inferring intent from a null path.

## 2. Relationship to the main PRD

- **Serves** the main-PRD goal (docs/PRD.md §3) "directly edit files with live preview, syntax highlighting, and undo/redo."
- **Leaves unchanged:** rendering of the preview lives in [`PRD-Rendering.md`](PRD-Rendering.md); saving, auto-save, and conflict handling live in [`PRD-Saving-and-Conflicts.md`](PRD-Saving-and-Conflicts.md).

Requirements here are numbered **R#**, local to this sub-PRD.

## 3. Concept

The source pane is source. It shows the markdown as written — no bold, no enlarged headings, no rendered structure — and uses colour alone to convey syntax, exactly as a code editor highlights a program. The preview is the rendered view. The two are separate surfaces, and scroll sync keeps them aligned so the reader can move through a long document without losing their place in either.

Formatting is applied, not typed. A shortcut wraps, toggles, or prefixes the current selection (or the cursor position) with the right markdown, so the user expresses intent — *make this bold*, *make this a level-3 heading* — without recalling the syntax. Wrapping shortcuts toggle: applying a marker that is already present removes it. List indentation, continuation, and ordered-list numbering follow markdown's structure so nesting renders as nesting and editing stays cheap.

The editor also tracks **what it is showing as an explicit state**, not as a null-path heuristic. The never-saved welcome sandbox, a real file on disk, and (in future) an untitled buffer are distinct states with distinct behavior, so the app never has to guess whether an empty path means "scratch space" or "unsaved work."

## 4. Goals

- Edit the markdown source directly, with the rendered preview updating as the user types.
- Keep the editor clearly *source* — colour-only highlighting, uniform monospace — never a second rendered view.
- Provide undo/redo and find & replace.
- Apply markdown formatting via keyboard shortcuts (toggle plus smart selection handling) so the user never types the syntax.
- Model document state explicitly rather than inferring it from a missing file path.

## 5. Non-goals

- **Word / character count.**
- **Smart list-item selection** — extending a selection (or `Home`) to a list line's start stopping at the item's *content*, skipping the marker (`-` / `1.`). *(Future: [#89](https://github.com/eschgr/mdtool/issues/89).)*

## 6. Requirements

### Editing

- **R1.** Edit the markdown **source** directly in-app.
- **R2.** **Live preview**: the rendered view updates as the user types.
- **R3.** **Scroll synchronization:** the preview tracks the editor's scroll position (and vice versa where natural) so the two panes stay aligned, particularly on long documents.
- **R4.** **Syntax highlighting** in the editor — **colour only**. The source pane stays uniform monospace (no bold/italic/enlarged-heading rendering); colour conveys structure the way a code editor highlights syntax, keeping the editor clearly *source* rather than a second rendered view.
- **R5.** **Undo / redo** support. Undo `Ctrl/Cmd+Z`; redo `Ctrl/Cmd+Y` **and** `Ctrl/Cmd+Shift+Z` (both bound).
- **R6.** **Find and replace** within the current document, via the editor's search panel (opened with `Cmd/Ctrl+F`). The built-in feature set: incremental find with match highlighting, find next / previous, replace and replace-all, and toggles for **case-sensitive**, **whole-word**, and **regular-expression** matching. *(Provided by CodeMirror's search extension out of the box; a frequently used operation, especially in larger files. The toggle set is the component's default — captured here for completeness, not separately required.)*
- **R7.** **Line numbers** — nice-to-have, optional. *(Typically free from the editor component.)*

### Formatting shortcuts

Keyboard shortcuts that apply markdown formatting to the editor selection, so the user does not have to type or remember the syntax.

- **R8.** Provide keyboard shortcuts for the following formatting actions:

  | Action | Shortcut (macOS / Windows) | Markdown produced |
  |---|---|---|
  | Bold | `Cmd+B` / `Ctrl+B` | `**…**` |
  | Italic | `Cmd+I` / `Ctrl+I` | `_…_` (underscores — distinct from `**bold**`, and no accidental intra-word italics) |
  | Link | `Cmd+K` / `Ctrl+K` | `[…](…)` via dialog (see R14) |
  | Inline code | `Cmd+E` / `Ctrl+E` | `` `…` `` |
  | Strikethrough | `Cmd+Shift+X` / `Ctrl+Shift+X` | `~~…~~` |
  | Heading | `Cmd+1`…`Cmd+6` / `Ctrl+1`…`Ctrl+6` | line prefixed `#`…`######` |
  | Code block (fenced) | `Cmd+Shift+C` / `Ctrl+Shift+C` | wrap in ```` ``` ```` fences |
  | Indent list item | `Tab` | increases list nesting |
  | Outdent list item | `Shift+Tab` | decreases list nesting |

- **R9. Toggle behavior.** Each wrapping shortcut (bold, italic, inline code, strikethrough, code block) **toggles**: if the selection is already wrapped in that marker, the shortcut removes it rather than adding another layer.
  - **A bare cursor inside an existing span counts too.** With no selection but the cursor *within* a span of that type (e.g. `**Hello|world**` + bold), the shortcut removes the whole span instead of inserting a new empty pair. The span is found via the editor's Lezer syntax tree (the parser runs GFM, so strikethrough/tables/task-lists are recognized).
  - **Headings normalize to the requested level** rather than stacking. Applying a heading sets the line to exactly that level no matter its current level, and applying the line's *current* level removes the heading. Examples: `## Hello` + `Ctrl+4` → `#### Hello` (switches level, does **not** become `######`); `## Hello` + `Ctrl+2` → `Hello` (same level removes).

- **R10. Smart selection handling.** Each wrapping/prefixing shortcut behaves correctly with and without an active selection:
  - **Selection present** → wrap (or prefix, for headings/lists) the selected text.
  - **No selection** → insert the markers and place the cursor between them (e.g. `**|**`) so the user can type immediately.
  - *(Link is the exception — it always uses the dialog in R14.)*

- **R11. Indent / outdent.**
  - On a **list line**, `Tab` / `Shift+Tab` nest / un-nest the whole item from **anywhere on the line** — not just at the start. Nesting aligns the item with its parent's **CommonMark content column** (3 spaces under `1. `, 2 under `- `, 4 under `10. `), so nested lists actually render as nested rather than flattening or merging; un-nesting drops back to the parent item's column. The list marker is left untouched (numbered items keep their marker; the renderer numbers them — see R12). The cursor stays on the same character.
  - On any **other line**, `Tab` inserts indentation at the cursor and `Shift+Tab` outdents the line. `Tab` never moves focus out of the editor.
  - Indentation uses **spaces, not hard tab characters**, at the width set in R15.
- **R12. Lazy ordered-list numbering.** Galley never renumbers ordered lists; markers are left exactly as authored. The convention is **`1.` on every item**: because re-nesting or reordering never forces a renumber and the renderer shows the correct sequence, editing stays cheap.
- **R13. List continuation.** `Enter` on a non-empty list item starts a new item on the next line with the same indentation and marker — **ordered markers as `1.`** (per R12), bullets unchanged. `Enter` on an **empty** item ends the list (clears the marker). Off a list line, `Enter` is an ordinary newline.

- **R14. Link dialog.** `Cmd/Ctrl+K` opens a small dialog rather than inserting raw syntax, so the user never has to remember `[text](url)` ordering. Behavior:
  - **Two labeled fields:** **Text** and **URL**. Focus starts in the **URL** field.
  - **Creating a link:**
    - If text is selected, prefill **Text** with the selection; on confirm, insert `[text](url)` replacing the selection.
    - If nothing is selected, both fields start empty; on confirm, insert `[text](url)` at the cursor.
  - **Editing an existing link:** if the cursor is anywhere within an existing markdown link (any part of its `[text](url)` syntax), the dialog opens **prefilled** with that link's current Text and URL, and confirming updates the existing link in place.
  - **Remove-link button:** in edit mode, a **Remove link** action strips the link syntax and keeps the plain text (`[text](url)` → `text`).
  - *Nice-to-have (future, [#85](https://github.com/eschgr/mdtool/issues/85)):* if the clipboard contains a URL when the dialog opens, prefill the **URL** field with it.

- **R15. Indentation setting.** The editor indents with **spaces**, default width **2**. (Applies to R11 list nesting and general `Tab` indentation.)

> Implementation note (R8–R15): The wrap/heading/fence rules live in the pure, unit-tested `src/renderer/components/editorCommands.ts`; the keymap is registered at **highest precedence** so it wins over CodeMirror defaults (no clash on `Cmd/Ctrl+E` or `K`). The link dialog reads/writes through the editor handle, using the Lezer syntax tree to detect an existing link at the cursor. Clipboard-URL prefill (R14 nice-to-have) is future.

> Implementation note: CodeMirror 6 exposes keybindings via its keymap system, and wrap/toggle logic operates on selection ranges; existing markdown-command helpers cover much of R9–R10. The link dialog (R14) is a small renderer-side popover reading/writing the editor selection; detecting "cursor within a link" uses the markdown syntax tree (Lezer) CodeMirror already maintains.

### Document states

The editor tracks **what it is showing as an explicit state**, not as a null-path heuristic. Two kinds exist today (a third, `untitled`, arrives with Save As):

- **Welcome screen** — a built-in **sandbox** shown whenever no file is open. It introduces the app and lets the user play with the renderer. It is **never saved** (no auto-save, no watcher, no Save), the title bar reads **"Welcome!"**, and it makes no claim to be a file. Opening a file replaces it.
- **File** — a document opened from disk, with a path, baseline hash, watcher, and the full save/auto-save/conflict behavior.
- **Untitled** *(future, with Save As)* — an editable buffer with **no destination yet**. Unlike the welcome screen it holds the user's work: auto-save and watching can't run, but unsaved changes must be surfaced and the user offered a way to save (Save As). *Not implemented yet — do not treat the welcome screen as an unsaved buffer.*
