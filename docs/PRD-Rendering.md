# PRD: Galley — Markdown Rendering

**Status:** Draft
**Companion to:** [`docs/PRD.md`](PRD.md) — the main Galley PRD. This sub-PRD holds the detailed **markdown-rendering** requirements (the preview pipeline and the pre-build rendering spike); the main PRD's **§6 Features** section indexes it. Requirement IDs (**R#**) are numbered locally within this sub-PRD.

---

## 1. Summary

Galley's preview renders markdown source to HTML faithfully to Claude's typical output: **GitHub Flavored Markdown**, **LaTeX math**, and **syntax-highlighted fenced code**. The preview is read-only and live — it updates as the user edits the source. A pre-build rendering spike validated the pipeline end to end and settled the math engine before any UI was built around it. A robustness floor guarantees that a bad span degrades to its raw source rather than breaking the whole document.

## 2. Relationship to the main PRD

- **Serves** the main-PRD goal (see [`PRD.md`](PRD.md) §3) "view markdown files rendered as they would be expected from Claude's output."
- **Leaves** direct editing, live-preview wiring, and scroll synchronization to [`PRD-Editing.md`](PRD-Editing.md), which owns the source pane and how it drives this preview.
- **Touches** a product-level security concern: link-click routing from the preview to the system browser is also covered by the main PRD's safety framing (§7).

Requirements here are numbered **R#**, local to this sub-PRD.

## 3. Concept

The preview is a **fixed markdown-it pipeline** — GFM plugins plus `markdown-it-texmath` over the KaTeX engine plus highlight.js — that turns markdown source into HTML in the renderer process. Running in-renderer keeps the round trip local, so the preview can repaint live with zero latency as the user types.

The preview is a *rendering* of the source, never a second editable surface. It reflects the source; it is not a place to edit it.

A **robustness floor** keeps the preview from ever collapsing on bad input. A math-parse failure degrades to showing the raw source for that span (KaTeX `throwOnError:false`), and a whole-document guard keeps a single malformed document from blanking the view.

**Link handling** distinguishes three cases. Web and mail links open in the system default browser. In-page anchor links scroll the preview to the referenced heading. Local-file links open the target as a tab, resolved against the current document's folder.

## 4. Goals

- Render Claude's typical output faithfully: GFM, LaTeX math, and syntax-highlighted fenced code.
- De-risk the rendering approach with a spike against real Claude output before building UI around the preview.
- Never break the preview on bad input — degrade a bad span to its raw source.
- Keep preview links safe: web/mail links open in the system browser, with no in-app navigation.

## 5. Non-goals

- **Text color / font color** — not part of standard markdown (no CommonMark/GFM syntax); Claude does not emit it, and supporting it would require enabling raw-HTML passthrough.

## 6. Requirements

### Markdown rendering

- **R1.** Render a markdown flavor matching Claude's typical output: **GitHub Flavored Markdown (GFM)** — ATX headings, bold/italic, nested ordered/unordered lists, fenced code blocks with language info strings, tables, blockquotes, links, images, horizontal rules, and task lists (`- [ ]` / `- [x]`). *(GFM is assembled from markdown-it plugins/presets, not a single switch — see the spike subsection below and main PRD §11.)*
- **R2.** Render **LaTeX math**: at minimum inline `$...$` and block `$$...$$`. The delimiter set and rendering engine must be validated against real Claude output (see the spike subsection below), since Claude also emits `\(...\)` / `\[...\]` and literal `$` can appear in prose.
- **R3.** Apply **syntax highlighting inside fenced code blocks** based on the language info string.
- **R4.** Clicking a link **in the preview** opens it in the **system default browser**, never inside the app's own window. *(Also a safety requirement — prevents the renderer from navigating away or spawning an in-app browser window.)* **Exceptions:** (a) **in-page anchor links** (`#heading`) scroll the preview to that heading instead of leaving the app — headings are given GitHub-style id slugs so the LLM's cross-reference links work; (b) **local-file links** (relative/absolute paths or `file://`) open the target as a tab, resolved against the current document's folder, so cross-document links between an LLM's files navigate in-app — and a `#fragment` on such a link (`other.md#section`) scrolls the opened tab to that heading. **Autolinking** is limited to text carrying an explicit scheme (`https://…`, `mailto:…`); bare `name.ext` text (e.g. `architecture.md`) is left as plain text rather than autolinked — many extensions are also TLDs, so fuzzy autolinking would wrongly make filenames in prose clickable. Use `[label](architecture.md)` for an explicit, clickable file link.

### Rendering de-risking spike (pre-build)

- **R5.** Before building UI around the preview, run a **rendering spike**: render a corpus of representative real Claude output (math-heavy, table-heavy, code-heavy, task lists) through the candidate pipeline and confirm fidelity for GFM (R1), math delimiters (R2), and fenced-code highlighting (R3). This single spike de-risks the three rendering concerns together and decides the final plugin/engine choices before significant investment.
- **R6. Math fallback ladder.** If the primary math path is insufficient, fall back in this order: (1) primary KaTeX-based plugin (e.g. `@vscode/markdown-it-katex`); (2) `markdown-it-texmath` for configurable delimiter sets; (3) MathJax engine (more permissive LaTeX, larger/slower, acceptable for a local tool). **Floor behavior:** a math-parse failure must degrade to showing the raw source for that span, never break the whole preview.
  - **Resolution (spike run, decided).** The spike selected **rung 2: `markdown-it-texmath` with the KaTeX engine**, configured for both the dollar and bracket delimiter sets so all of `$…$`, `$$…$$`, `\(…\)`, and `\[…\]` render. Rung 1 (`@vscode/markdown-it-katex`) was insufficient — it renders dollar delimiters only and drops the `\(…\)` / `\[…\]` forms Claude also emits — and was dropped. texmath is structure-aware (skips code spans/fences) and its dollar guards keep literal `$` in prose (e.g. prices like "$5 and $10") from being parsed as math (R2). The floor is implemented via KaTeX `throwOnError:false` (renders a bad formula's raw source in an error color), plus a whole-document guard so one bad doc can't blank the preview.
