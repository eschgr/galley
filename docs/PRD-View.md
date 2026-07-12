# PRD: Galley — Document View

**Status:** Draft

---

## 1. Summary

Galley's document view is two reflecting surfaces onto one markdown document: a live **rendered preview** and a **source editor**. The preview renders the source to HTML faithfully to Claude's typical output — **GitHub Flavored Markdown**, **LaTeX math**, and **syntax-highlighted fenced code** — and is read-only, updating as the source is edited. The editor edits the markdown **source** directly: uniform monospace with color-only highlighting, kept visually distinct from the rendered view the way a code editor is distinct from what it produces. Scroll sync keeps the two panes aligned, and formatting shortcuts apply markdown to the selection — bold, italic, code, headings, lists, links — so the user never types the syntax by hand. A robustness floor guarantees a bad span degrades to its raw source rather than breaking the whole document, and an explicit **document-state** model governs what the view is showing rather than inferring intent from a null path.

## 2. Relationship to the main PRD

- **Serves** the main-PRD goals (see [`PRD.md`](PRD.md) §3): "view markdown files rendered as they would be expected from Claude's output" **and** "directly edit files with live preview, syntax highlighting, and undo/redo."
- **Leaves** saving, auto-save, and conflict handling to [`PRD-Saving-and-Conflicts.md`](PRD-Saving-and-Conflicts.md), and the tab/shell surface to [`PRD-UI-Shell.md`](PRD-UI-Shell.md).
- **Touches** a product-level security concern: link-click routing from the preview to the system browser is also covered by the main PRD's safety framing (§7).

Requirements here are numbered **R#**, local to this sub-PRD.

## 3. Concept

The document view is two surfaces onto one document, each reflecting the other.

The **rendered preview** is a *rendering* of the source, never a second editable surface — it reflects the source; it is not a place to edit it. It is a **fixed markdown-it pipeline** — GFM plugins plus `markdown-it-texmath` over the KaTeX engine plus highlight.js — that turns markdown source into HTML in the renderer process. Running in-renderer keeps the round trip local, so the preview repaints live with zero latency as the user types. A **robustness floor** keeps it from ever collapsing on bad input: a math-parse failure degrades to showing the raw source for that span (KaTeX `throwOnError:false`), and a whole-document guard keeps a single malformed document from blanking the view. **Link handling** distinguishes three cases — web and mail links open in the system default browser, in-page anchor links scroll the preview to the referenced heading, and local-file links open the target as a tab, resolved against the current document's folder.

The **source editor** is source. It shows the markdown as written — no bold, no enlarged headings, no rendered structure — and uses color alone to convey syntax, exactly as a code editor highlights a program. Formatting is applied, not typed: a shortcut wraps, toggles, or prefixes the current selection (or the cursor position) with the right markdown, so the user expresses intent — *make this bold*, *make this a level-3 heading* — without recalling the syntax. Wrapping shortcuts toggle: applying a marker that is already present removes it. List indentation, continuation, and ordered-list numbering follow markdown's structure so nesting renders as nesting and editing stays cheap.

The two surfaces stay aligned. The preview is the rendering; the editor is the source. Live preview updates as the source is edited, and scroll sync keeps the panes aligned so the reader can move through a long document without losing their place in either.

The view also tracks **what it is showing as an explicit state**, not as a null-path heuristic. The never-saved welcome sandbox, a real file on disk, and (in future) an untitled buffer are distinct states with distinct behavior, so the app never has to guess whether an empty path means "scratch space" or "unsaved work." This document-state model governs what both surfaces show.

## 4. Goals

- Render Claude's typical output faithfully: GFM, LaTeX math, and syntax-highlighted fenced code.
- De-risk the rendering approach with a spike against real Claude output before building UI around the preview.
- Never break the preview on bad input — degrade a bad span to its raw source.
- Keep preview links safe: web/mail links open in the system browser, with no in-app navigation.
- Edit the markdown source directly, with the rendered preview updating as the user types.
- Keep the editor clearly *source* — color-only highlighting, uniform monospace — never a second rendered view.
- Provide undo/redo, find & replace in the source, and find in the rendered preview.
- Apply markdown formatting via keyboard shortcuts (toggle plus smart selection handling) so the user never types the syntax.
- Model document state explicitly rather than inferring it from a missing file path.

## 5. Non-goals

- **Text color / font color** — not part of standard markdown (no CommonMark/GFM syntax); Claude does not emit it, and supporting it would require enabling raw-HTML passthrough.
- **Word / character count** — Galley is a review/edit surface, not a writing-stats tool.

## 6. Requirements

### Markdown rendering

- **R1.** Render a markdown flavor matching Claude's typical output: **GitHub Flavored Markdown (GFM)** — ATX headings, bold/italic, nested ordered/unordered lists, fenced code blocks with language info strings, tables, blockquotes, links, images, horizontal rules, and task lists (`- [ ]` / `- [x]`). *(GFM is assembled from markdown-it plugins/presets, not a single switch — see the rendering de-risking spike subsection below and main PRD §11.)*
- **R2.** Render **LaTeX math**: at minimum inline `$...$` and block `$$...$$`. The delimiter set and rendering engine must be validated against real Claude output (see the rendering de-risking spike subsection below), since Claude also emits `\(...\)` / `\[...\]` and literal `$` can appear in prose.
- **R3.** Apply **syntax highlighting inside fenced code blocks** based on the language info string.
- **R4. Link handling in the preview.** Each kind of link in the rendered preview is handled by its type:
  - **Web / mail links** (`https://…`, `mailto:…`) open in the **system default browser**, never inside the app's own window. *(Also a safety requirement — the renderer must not navigate away or spawn an in-app browser window.)*
  - **In-page anchor links** (`#heading`) scroll the preview to that heading. Headings are given GitHub-style id slugs so the LLM's cross-reference links resolve.
  - **Local-file links** (relative or absolute paths, or `file://`) open the target as a tab, resolved against the current document's folder, so cross-document links between an LLM's files navigate in-app. A `#fragment` on such a link (`other.md#section`) scrolls the opened tab to that heading.
  - **Bare filenames in prose** (e.g. `architecture.md`) are left as plain text, **not** autolinked — many extensions are also TLDs, so fuzzy autolinking would wrongly make filenames clickable. Autolinking applies only to text carrying an explicit scheme; use `[label](architecture.md)` for an explicit, clickable file link.
- **R4a. Rendered task-list checkboxes are read-only.** GFM `- [ ]` / `- [x]` checkboxes in the preview render **disabled**. The preview reflects the source and is not an editing surface, so clicking a box can't diverge it from the `- [ ]` / `- [x]` in the source; a task is toggled by editing the source in the editor.

### Rendering de-risking spike (pre-build)

- **R5.** Before building UI around the preview, run a **rendering spike**: render a corpus of representative real Claude output (math-heavy, table-heavy, code-heavy, task lists) through the candidate pipeline and confirm fidelity for GFM (R1), math delimiters (R2), and fenced-code highlighting (R3). This single spike de-risks the three rendering concerns together and decides the final plugin/engine choices before significant investment.
- **R6. Math fallback ladder.** If the primary math path is insufficient, fall back in this order: (1) primary KaTeX-based plugin (e.g. `@vscode/markdown-it-katex`); (2) `markdown-it-texmath` for configurable delimiter sets; (3) MathJax engine (more permissive LaTeX, larger/slower, acceptable for a local tool). **Floor behavior:** a math-parse failure must degrade to showing the raw source for that span, never break the whole preview.
  - **Resolution (spike run, decided).** The spike selected **rung 2: `markdown-it-texmath` with the KaTeX engine**, configured for both the dollar and bracket delimiter sets so all of `$…$`, `$$…$$`, `\(…\)`, and `\[…\]` render. Rung 1 (`@vscode/markdown-it-katex`) was insufficient — it renders dollar delimiters only and drops the `\(…\)` / `\[…\]` forms Claude also emits — and was dropped. texmath is structure-aware (skips code spans/fences) and its dollar guards keep literal `$` in prose (e.g. prices like "$5 and $10") from being parsed as math (R2). The floor is implemented via KaTeX `throwOnError:false` (renders a bad formula's raw source in an error color), plus a whole-document guard so one bad doc can't blank the preview.

### Editing

- **R7.** Edit the markdown **source** directly in-app.
- **R8.** **Live preview**: the rendered view updates as the user types.
- **R9.** **Scroll synchronization:** the preview tracks the editor's scroll position (and vice versa where natural) so the two panes stay aligned, particularly on long documents.
- **R9a. Reveal a target line on open.** When a file is opened at a target line (the opening surfaces are the Opening-and-Instances sub-PRD's concern — CLI `path:line` and the channel envelope), the rendered preview scrolls that line **into view with surrounding context** (roughly centred, not pinned to the very top or bottom) and gives it a **brief highlight** so the reader's eye lands on it; when the source pane is shown, the editor is positioned to the same line. The target is 1-based and **clamped to the document's bounds** (a line past the end reveals the end; a line below 1 reveals the top). The reveal is anchored to the preview's `data-source-line` blocks — the same line map scroll sync uses — so it targets the block containing (or nearest before) the line. If the file is already open, its tab is focused and scrolled to the line rather than duplicated. *(One-shot on open; ordinary reading and scroll sync are unchanged afterwards.)*
- **R10.** **Syntax highlighting** in the editor — **color only**. The source pane stays uniform monospace (no bold/italic/enlarged-heading rendering); color conveys structure the way a code editor highlights syntax, keeping the editor clearly *source* rather than a second rendered view.
- **R11.** **Undo / redo** support. Undo `Ctrl/Cmd+Z`; redo `Ctrl/Cmd+Y` **and** `Ctrl/Cmd+Shift+Z` (both bound).
- **R12.** **Find and replace** within the current document, via the editor's search panel (opened with `Cmd/Ctrl+F`). The built-in feature set: incremental find with match highlighting, find next / previous, replace and replace-all, and toggles for **case-sensitive**, **whole-word**, and **regular-expression** matching. *(Provided by CodeMirror's search extension out of the box; a frequently used operation, especially in larger files. The toggle set is the component's default — captured here for completeness, not separately required.)*
- **R12a. Find in the rendered preview.** A find bar searches the **rendered preview** — the document as read, not its source — so a reviewer can locate text in the pane they are actually reading. It opens with `Cmd/Ctrl+F` when the **rendered preview is focused** — the reading surface, and the default while the source pane is hidden — while the editor's own find (R12) keeps that key when the source editor is focused. It is available whether or not the source pane is shown. Closed with `Esc`. The bar highlights **all** matches in the rendered view, marks the current match distinctly, and shows the active position as **_n_ of _N_**. `Enter` / `Shift+Enter` (or next/previous controls) move between matches with **wraparound**, scrolling the current match into view with context. Matching is **case-insensitive** by default, with a **match-case** toggle. Search is over the rendered *text*, skipping markup and non-content spans (e.g. math internals). Each open tab keeps its **own** find state — query, current match, toggles — mirroring the per-tab kept-mounted views (the tab/instance model is [`PRD-UI-Shell.md`](PRD-UI-Shell.md)'s concern). Highlighting paints over the live preview **without mutating its DOM**, so it never disturbs the `data-source-line` anchor map that scroll sync (R9) and reveal-on-open (R9a) depend on. *(R12 and R12a share the `Cmd/Ctrl+F` key and are disambiguated by which pane holds focus: source editor → R12, otherwise → the preview find.)*
- **R13.** **Line numbers** — nice-to-have, optional. *(Typically free from the editor component.)*

### Formatting shortcuts

Keyboard shortcuts that apply markdown formatting to the editor selection, so the user does not have to type or remember the syntax.

- **R14.** Provide keyboard shortcuts for the following formatting actions:

  | Action | Shortcut (macOS / Windows) | Markdown produced |
  |---|---|---|
  | Bold | `Cmd+B` / `Ctrl+B` | `**…**` |
  | Italic | `Cmd+I` / `Ctrl+I` | `_…_` (underscores — distinct from `**bold**`, and no accidental intra-word italics) |
  | Link | `Cmd+K` / `Ctrl+K` | `[…](…)` via dialog (see R20) |
  | Inline code | `Cmd+E` / `Ctrl+E` | `` `…` `` |
  | Strikethrough | `Cmd+Shift+X` / `Ctrl+Shift+X` | `~~…~~` |
  | Heading | `Cmd+1`…`Cmd+6` / `Ctrl+1`…`Ctrl+6` | line prefixed `#`…`######` |
  | Code block (fenced) | `Cmd+Shift+C` / `Ctrl+Shift+C` | wrap in ```` ``` ```` fences |
  | Indent list item | `Tab` | increases list nesting |
  | Outdent list item | `Shift+Tab` | decreases list nesting |

- **R15. Toggle behavior.** Each wrapping shortcut (bold, italic, inline code, strikethrough, code block) **toggles**: if the selection is already wrapped in that marker, the shortcut removes it rather than adding another layer.
  - **A bare cursor inside an existing span counts too.** With no selection but the cursor *within* a span of that type (e.g. `**Hello|world**` + bold), the shortcut removes the whole span instead of inserting a new empty pair. The span is found via the editor's Lezer syntax tree (the parser runs GFM, so strikethrough/tables/task-lists are recognized).
  - **Headings normalize to the requested level** rather than stacking. Applying a heading sets the line to exactly that level no matter its current level, and applying the line's *current* level removes the heading. Examples: `## Hello` + `Ctrl+4` → `#### Hello` (switches level, does **not** become `######`); `## Hello` + `Ctrl+2` → `Hello` (same level removes).

- **R16. Smart selection handling.** Each wrapping/prefixing shortcut behaves correctly with and without an active selection:
  - **Selection present** → wrap (or prefix, for headings/lists) the selected text.
  - **No selection** → insert the markers and place the cursor between them (e.g. `**|**`) so the user can type immediately.
  - *(Link is the exception — it always uses the dialog in R20.)*

- **R17. Indent / outdent.**
  - On a **list line**, `Tab` / `Shift+Tab` nest / un-nest the whole item from **anywhere on the line** — not just at the start. Nesting aligns the item with its parent's **CommonMark content column** (3 spaces under `1. `, 2 under `- `, 4 under `10. `), so nested lists actually render as nested rather than flattening or merging; un-nesting drops back to the parent item's column. The list marker is left untouched (numbered items keep their marker; the renderer numbers them — see R18). The cursor stays on the same character.
  - On any **other line**, `Tab` inserts indentation at the cursor and `Shift+Tab` outdents the line. `Tab` never moves focus out of the editor.
  - Indentation uses **spaces, not hard tab characters**, at the width set in R21.
- **R18. Lazy ordered-list numbering.** Galley never renumbers ordered lists; markers are left exactly as authored. The convention is **`1.` on every item**: because re-nesting or reordering never forces a renumber and the renderer shows the correct sequence, editing stays cheap.
- **R19. List continuation.** `Enter` on a non-empty list item starts a new item on the next line with the same indentation and marker — **ordered markers as `1.`** (per R18), bullets unchanged. `Enter` on an **empty** item ends the list (clears the marker). Off a list line, `Enter` is an ordinary newline. **When the caret sits before the content** (in the line's indent, marker, or trailing spaces — e.g. at the very start of `1. hello`), `Enter` opens a blank line above, moving the item down, rather than duplicating the marker (`1. 1. hello`).

- **R20. Link dialog.** `Cmd/Ctrl+K` opens a small dialog rather than inserting raw syntax, so the user never has to remember `[text](url)` ordering. Behavior:
  - **Two labeled fields:** **Text** and **URL**. Focus starts in the **URL** field.
  - **Creating a link:**
    - If text is selected, prefill **Text** with the selection; on confirm, insert `[text](url)` replacing the selection.
    - If nothing is selected, both fields start empty; on confirm, insert `[text](url)` at the cursor.
  - **Editing an existing link:** if the cursor is anywhere within an existing markdown link (any part of its `[text](url)` syntax), the dialog opens **prefilled** with that link's current Text and URL, and confirming updates the existing link in place.
  - **Remove-link button:** in edit mode, a **Remove link** action strips the link syntax and keeps the plain text (`[text](url)` → `text`).
  - *Nice-to-have (future, [#85](https://github.com/eschgr/mdtool/issues/85)):* if the clipboard contains a URL when the dialog opens, prefill the **URL** field with it.

- **R21. Indentation setting.** The editor indents with **spaces**, default width **2**. (Applies to R17 list nesting and general `Tab` indentation.)

> Implementation note (R14–R21): The wrap/heading/fence rules live in the pure, unit-tested `src/renderer/components/editorCommands.ts`; the keymap is registered at **highest precedence** so it wins over CodeMirror defaults (no clash on `Cmd/Ctrl+E` or `K`). The link dialog reads/writes through the editor handle, using the Lezer syntax tree to detect an existing link at the cursor. Clipboard-URL prefill (R20 nice-to-have) is future.

> Implementation note: CodeMirror 6 exposes keybindings via its keymap system, and wrap/toggle logic operates on selection ranges; existing markdown-command helpers cover much of R15–R16. The link dialog (R20) is a small renderer-side popover reading/writing the editor selection; detecting "cursor within a link" uses the markdown syntax tree (Lezer) CodeMirror already maintains.

### Writing aids

- **R22. Spell-checking.** The source editor enables the browser's native spell-checker: misspelled words get the usual red underline, and **right-clicking one opens a context menu of spelling suggestions plus Add to Dictionary** (persistent). *(The squiggles are native; the suggestion/add menu is built by a main-process context-menu handler over the native checker, since the browser leaves building that menu to the app. Prose-oriented — text inside fenced code blocks is checked too, an accepted trade-off vs. a much heavier Markdown-aware checker. Only a permanent add-to-dictionary is offered, not a session-only "ignore" — the native checker doesn't support one. Squiggles cover the on-screen text; the editor virtualizes off-screen lines.)*
- **R23. Word autocomplete.** As the user types (after a few characters), the editor offers word completions — the document's own words first (contextual), then a bundled common-English dictionary ranked by frequency. It is **offline and heuristic** — no model, no network. Accept with `Tab` (or click); `Enter` stays a newline; `Esc` dismisses; `Cmd/Ctrl+Space` triggers manually. *(A larger, LLM-backed completion is a possible future direction, out of scope here.)*

### Document states

The view tracks **what it is showing as an explicit state**, not as a null-path heuristic. Two kinds exist today (a third, `untitled`, arrives with Save As):

- **Welcome screen** — a built-in **sandbox** shown whenever no file is open. It introduces the app and lets the user play with the renderer. It is **never saved** (no auto-save, no watcher, no Save), the title bar reads **"Welcome!"**, and it makes no claim to be a file. Opening a file replaces it.
- **File** — a document opened from disk, with a path, baseline hash, watcher, and the full save/auto-save/conflict behavior.
- **Untitled** *(future, with Save As)* — an editable buffer with **no destination yet**. Unlike the welcome screen it holds the user's work: auto-save and watching can't run, but unsaved changes must be surfaced and the user offered a way to save (Save As). *Not implemented yet — do not treat the welcome screen as an unsaved buffer.*
