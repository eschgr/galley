# PRD: Galley — UI Shell (Tabs, Layout, Menu, Help, Print & Export)

**Status:** Draft (split from the main PRD v11, 2026-07-04)
**Companion to:** [`docs/PRD.md`](PRD.md) — the main Galley PRD. This sub-PRD holds the detailed **tabs**, **layout & empty state**, **application menu**, **help**, and **print & export** requirements — the application-shell feature areas; the main PRD's **§5 Features** section indexes it. Requirement IDs (**R#**) are unchanged by the split.

---

## 1. Tabs

- **R39.** Open multiple documents, each in its own tab; switch between them.
- **R40.** **Per-tab dirty indicator** showing unsaved local changes.
- **R41.** Close an individual tab — via the tab's **×** or **Ctrl/Cmd+W** (which closes the active tab, never the window). Closing a tab with unsaved local edits prompts to save first (Save / Discard / Cancel). *(With auto-save, most closes have nothing pending; the prompt covers the un-debounced window.)* Closing the **last** tab returns to the welcome/empty state (R46), it does not quit.
- **R42.** Recently-opened list — **not required**.
- **R43.** Tab reordering — **not required**; include only if provided for free by the UI framework.
- **R44.** Bulk tab operations (close all / close others) — **out of scope** (see main PRD §4).

> Status (2026-06-20): R39–R41 implemented. One CodeMirror instance is shared across tabs; each tab stashes/restores its full editor state (undo/scroll/selection) on switch, and carries its own buffer, baseline, dirty, and out-of-sync state. Opening a file already open focuses its tab rather than duplicating. Closing a tab unwatches its file; closing a *dirty* tab prompts (Save / Discard / Cancel). R42/R43 remain not-done by design.

## 2. Layout & empty state

- **R45. Split view & reading mode.** The live rendered view (left) and source editor (right) are shown side by side with synchronized scrolling (R18). A **Show Source / Hide Source** toggle in the title bar collapses the editor so the rendered view fills the window for distraction-free reading, and restores the side-by-side split for editing. *(Pane order is fixed; a dynamic in-app swap is out of scope — see main PRD §4.)*
  - **Default to reading view.** Because the primary use is reviewing rendered output, the app opens with the source hidden (rendered view only); one click on **Show Source** reveals the editor to make corrections, and **Hide Source** returns to full-window reading. The editor stays mounted while hidden, so edits, undo history, and scroll position are preserved across toggles.
  - **Window auto-resize.** Showing the source roughly **doubles the window width** to make room for the side-by-side editor, and hiding it restores the earlier (reading) width — so the reading view stays comfortably narrow and the editing view stays roomy. The reading width is remembered per window (respecting a manual resize), the target is clamped to the display work area and nudged to stay on-screen, and the height is unchanged. No resize happens when the window is maximized or full screen.
- **R46. Empty state.** When no files are open — whether at a fresh launch with no file argument (R10) or after the last tab is closed — the app remains open and displays the **welcome screen** (the document-states sandbox in [`PRD-Editing.md`](PRD-Editing.md#3-document-states)), which serves as the "no files open" state; the tab strip is hidden. Closing the last tab does **not** quit the app. *(Implemented 2026-06-20.)*

## 3. Application menu & commands

- **R47. Native menu bar.** Common operations are exposed through the **OS-native application menu** (not a custom command palette). At minimum:
  - **File:** Open (R8), Save / force-save (R30), Reload File (R31a, `Ctrl/Cmd+R`), Export to PDF (R52, `Ctrl/Cmd+Shift+P`), Print (R53, `Ctrl/Cmd+P`), Close Tab (R41, `Ctrl/Cmd+W`), Exit (quit the application).
  - **Edit:** Undo/redo (R20), Find & Replace (R21), and the formatting actions (R23) where appropriate.
  - **Help:** open the Help window (R48), and **Toggle Developer Tools**. *(DevTools do not open on a normal launch; they are opt-in via this menu item or a `--devtools` launch flag.)*
  - *(No **View** or **Window** menu: their only deliberate items — Reload File and window close — live in File; standard view items like zoom and full screen are omitted as unused clutter.)*
- *(A searchable command palette is explicitly not built for this version; the native menu covers these operations. The Show/Hide Source view toggle (R45) lives in the title bar rather than the menu.)*

## 4. Help

- **R48. Help window.** A Help window/dialog showing:
  - **Basic app info** — name, version, short description.
  - **License info** — the app's license plus bundled third-party attribution notice (satisfies the main PRD §10 attribution obligation in-app).
  - **Keyboard shortcuts** — a readable reference of all shortcuts (formatting shortcuts R23, save/force-save, find & replace, print & export-to-PDF R52/R53, menu operations), so the user has an in-app reminder.

## 5. Print & Export to PDF

Both features render **only the active tab's rendered preview** — never the toolbar, tab strip, source editor, split divider, out-of-sync banner, or any open dialog. They share one print stylesheet (`@media print`), since Electron renders both `webContents.print()` and `webContents.printToPDF()` with PRINT media. *(Numbering note: R49–R51 are the non-functional requirements in main PRD §5; these new functional requirements take R52/R53.)*

- **R52. Export to PDF (`File → Export to PDF…`, `Ctrl/Cmd+Shift+P`).** Writes the active document's rendered preview to a PDF. Export **always** presents a native Save As dialog, pre-filled with a suggested filename and folder; the PDF is written only on explicit confirmation, and canceling writes nothing — the dialog is both a safety catch and a clear indication of where the file lands. The default is the source file's name with a `.pdf` extension (`notes.md` → `notes.pdf`) in **the source file's folder**; with no file open it is `Galley document.pdf` in the user's Documents folder. **Page size Letter, 0.75in margins, backgrounds preserved**; the full document paginates (never clipped to the viewport). Save/IO errors surface as an error dialog, not a crash. *(Priority feature.)*
- **R53. Print (`File → Print…`, `Ctrl/Cmd+P`).** Opens the OS print dialog for the active document's rendered preview, with the same chrome-stripped, full-document, backgrounds-on rendering as R52. Paper, margins, and headers beyond the defaults are the OS dialog's concern.
- **R52a / R53a. Shared print-rendering rules.** The print stylesheet must: (1) **release the fixed-height scroll chain** (`.app` / `.split-view` / `.pane` / `.preview-scroll` height + overflow) so the whole document flows across pages instead of clipping to the viewport; (2) **hide all non-preview chrome**; (3) **keep backgrounds** (`printBackground: true` plus `print-color-adjust: exact`); (4) apply sensible pagination — avoid breaking inside code blocks / tables, and wrap long code lines and wide tables so they do not run off the page.
- **R52b. No new runtime dependencies** — printing and PDF export use Electron's built-in `webContents` APIs (supports the main PRD §5 self-contained goal).
- **R52c. Wiring.** The menu handlers run in the main process and call `webContents.print()` / `printToPDF()` directly — printing is main-process work and needs no renderer round-trip. The one fact main lacks, the active document's path (for the save-dialog default), is supplied by a single one-way `setActiveDocPath` signal from the renderer (analogous to `setSourceVisible`). *(IPC follows data ownership: Save / Save-As bounce through the renderer because the buffer and post-write state are renderer-owned; Export reads the live page main already controls and mutates no document state, so it does not.)*
- **Out of scope this version:** page numbers / running headers-footers, an in-app page-size or margin chooser, and opening the PDF after export (see main PRD §4 and §12).
