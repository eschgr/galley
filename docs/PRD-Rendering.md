# PRD: Galley — Markdown Rendering

**Status:** Draft (split from the main PRD v11, 2026-07-04)
**Companion to:** [`docs/PRD.md`](PRD.md) — the main Galley PRD. This sub-PRD holds the detailed **markdown-rendering** requirements (the preview pipeline and the pre-build rendering spike); the main PRD's **§6 Features** section indexes it. Requirement IDs (**R#**) are numbered locally within this sub-PRD.

---

## 1. Markdown rendering

- **R1.** Render a markdown flavor matching Claude's typical output: **GitHub Flavored Markdown (GFM)** — ATX headings, bold/italic, nested ordered/unordered lists, fenced code blocks with language info strings, tables, blockquotes, links, images, horizontal rules, and task lists (`- [ ]` / `- [x]`). *(GFM is assembled from markdown-it plugins/presets, not a single switch — see §2 below and main PRD §11.)*
- **R2.** Render **LaTeX math**: at minimum inline `$...$` and block `$$...$$`. The delimiter set and rendering engine must be validated against real Claude output (see §2 below), since Claude also emits `\(...\)` / `\[...\]` and literal `$` can appear in prose.
- **R3.** Apply **syntax highlighting inside fenced code blocks** based on the language info string.
- **R4.** Clicking a link **in the preview** opens it in the **system default browser**, never inside the app's own window. *(Also a safety requirement — prevents the renderer from navigating away or spawning an in-app browser window.)* **Exceptions:** (a) **in-page anchor links** (`#heading`) scroll the preview to that heading instead of leaving the app — headings are given GitHub-style id slugs so the LLM's cross-reference links work; (b) **local-file links** (relative/absolute paths or `file://`) open the target as a tab, resolved against the current document's folder, so cross-document links between an LLM's files navigate in-app — and a `#fragment` on such a link (`other.md#section`) scrolls the opened tab to that heading. **Autolinking** is limited to text carrying an explicit scheme (`https://…`, `mailto:…`); bare `name.ext` text (e.g. `architecture.md`) is left as plain text rather than autolinked — many extensions are also TLDs, so fuzzy autolinking would wrongly make filenames in prose clickable. Use `[label](architecture.md)` for an explicit, clickable file link.

## 2. Rendering de-risking spike (pre-build)

- **R5.** Before building UI around the preview, run a **rendering spike**: render a corpus of representative real Claude output (math-heavy, table-heavy, code-heavy, task lists) through the candidate pipeline and confirm fidelity for GFM (R1), math delimiters (R2), and fenced-code highlighting (R3). This single spike de-risks the three rendering concerns together and decides the final plugin/engine choices before significant investment.
- **R6. Math fallback ladder.** If the primary math path is insufficient, fall back in this order: (1) primary KaTeX-based plugin (e.g. `@vscode/markdown-it-katex`); (2) `markdown-it-texmath` for configurable delimiter sets; (3) MathJax engine (more permissive LaTeX, larger/slower, acceptable for a local tool). **Floor behavior:** a math-parse failure must degrade to showing the raw source for that span, never break the whole preview.
  - **Resolution (spike run, decided).** The spike selected **rung 2: `markdown-it-texmath` with the KaTeX engine**, configured for both the dollar and bracket delimiter sets so all of `$…$`, `$$…$$`, `\(…\)`, and `\[…\]` render. Rung 1 (`@vscode/markdown-it-katex`) was insufficient — it renders dollar delimiters only and drops the `\(…\)` / `\[…\]` forms Claude also emits — and was dropped. texmath is structure-aware (skips code spans/fences) and its dollar guards keep literal `$` in prose (e.g. prices like "$5 and $10") from being parsed as math (R2). The floor is implemented via KaTeX `throwOnError:false` (renders a bad formula's raw source in an error color), plus a whole-document guard so one bad doc can't blank the preview.

## 3. Non-goals

- **Text color / font color** — not part of standard markdown (no CommonMark/GFM syntax); Claude does not emit it, and supporting it would require enabling raw-HTML passthrough.
