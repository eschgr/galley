# PRD: Galley — UI Shell (Tabs, Layout, Menu, Help, Print & Export)

**Status:** Draft

---

## 1. Summary

The UI Shell is the application frame around the documents: multiple open documents presented as **tabs**, a split/reading-mode **layout**, the OS-native **application menu**, an in-app **Help** window, and **Print / Export to PDF**. It covers everything that presents and commands documents rather than rendering or editing their content. One window hosts the whole surface, opening reading-first and expanding to a side-by-side editing split on demand.

## 2. Relationship to the main PRD

- **Serves** the main-PRD goal "manage multiple open documents in a tabbed interface" ([`PRD.md`](PRD.md) §3) and the reading-first review workflow it implies.
- **Leaves unchanged** the document view ([`PRD-View.md`](PRD-View.md)), and saving/conflicts ([`PRD-Saving-and-Conflicts.md`](PRD-Saving-and-Conflicts.md)) — this sub-PRD frames and commands the documents those features produce.
- The Help window carries the third-party attribution notice that satisfies the main PRD §10 obligation in-app, and Print / Export honour the self-contained goal (main PRD §5) by using only built-in Electron APIs.

Requirements here are numbered **R#**, local to this sub-PRD.

## 3. Concept

One window hosts multiple open documents as **tabs**, each carrying its own buffer, baseline, dirty, and out-of-sync state. A single CodeMirror instance is shared across tabs; each tab stashes and restores its full editor state (undo history, scroll, selection) on switch, so switching tabs is lossless and opening an already-open file focuses its tab rather than duplicating it.

The layout defaults to **distraction-free reading**: the source editor is hidden and the rendered view fills the window, matching the primary use of reviewing rendered output. A single **Show Source** toggle reveals the side-by-side split for corrections, and **Hide Source** returns to full-window reading; the editor stays mounted while hidden so edits and history survive the toggle.

Commands live in the **OS-native application menu** — there is no custom command palette. The view toggle lives in the title bar, and the menu covers the common file, edit, and help operations.

Print and Export to PDF render **only the active tab's rendered preview** through one shared print stylesheet, stripping all chrome and paginating the full document rather than clipping to the viewport.

## 4. Goals

- Present multiple open documents as tabs, each with its own per-tab state and dirty indicator.
- Default to a reading-first split layout that stays out of the way and expands to side-by-side editing on demand.
- Expose the common operations through a native application menu (no custom palette).
- Provide an in-app Help window with app info, license/attribution, and a keyboard-shortcuts reference.
- Print and export to PDF faithfully from the rendered preview, chrome-stripped and fully paginated.

## 5. Non-goals

- **A searchable command palette** — the OS-native application menu covers the operations by design; Galley does not add a custom command palette.

## 6. Requirements

### Tabs

- **R1.** Open multiple documents, each in its own tab; switch between them.
- **R2.** **Per-tab dirty indicator** showing unsaved local changes.
- **R3.** Close an individual tab — via the tab's **×** or **Ctrl/Cmd+W** (which closes the active tab, never the window). Closing a tab with unsaved local edits prompts to save first (Save / Discard / Cancel). *(With auto-save, most closes have nothing pending; the prompt covers the un-debounced window.)* Closing the **last** tab returns to the welcome/empty state (R5), it does not quit.

One CodeMirror instance is shared across tabs; each tab stashes/restores its full editor state (undo/scroll/selection) on switch, and carries its own buffer, baseline, dirty, and out-of-sync state. Opening a file already open focuses its tab rather than duplicating. Closing a tab unwatches its file; closing a *dirty* tab prompts (Save / Discard / Cancel).

### Layout & empty state

- **R4. Split view & reading mode.** The live rendered view (left) and source editor (right) are shown side by side with synchronized scrolling. A **Show Source / Hide Source** toggle in the title bar collapses the editor so the rendered view fills the window for distraction-free reading, and restores the side-by-side split for editing. **Pane order is fixed** (rendered view left, source right).
  - **Default to reading view.** Because the primary use is reviewing rendered output, the app opens with the source hidden (rendered view only); one click on **Show Source** reveals the editor to make corrections, and **Hide Source** returns to full-window reading. The editor stays mounted while hidden, so edits, undo history, and scroll position are preserved across toggles.
  - **Window auto-resize.** Showing the source roughly **doubles the window width** to make room for the side-by-side editor, and hiding it restores the earlier (reading) width — so the reading view stays comfortably narrow and the editing view stays roomy. The reading width is remembered per window (respecting a manual resize), the target is clamped to the display work area and nudged to stay on-screen, and the height is unchanged. No resize happens when the window is maximized or full screen.
- **R5. Empty state.** When no files are open — whether at a fresh launch with no file argument or after the last tab is closed — the app remains open and displays the **welcome screen** (the document-states sandbox in [`PRD-View.md`](PRD-View.md#document-states)), which serves as the "no files open" state; the tab strip is hidden. Closing the last tab does **not** quit the app.

### Application menu & commands

- **R6. Native menu bar.** Common operations are exposed through the **OS-native application menu** (not a custom command palette). At minimum:
  - **File:** Open, Save / force-save, Reload File (`Ctrl/Cmd+R`), Export to PDF (R8, `Ctrl/Cmd+Shift+P`), Print (R9, `Ctrl/Cmd+P`), Close Tab (R3, `Ctrl/Cmd+W`), Exit (quit the application).
  - **Edit:** Undo/redo, Find & Replace, and the formatting actions where appropriate.
  - **Help:** open the Help window (R7), and **Toggle Developer Tools**. *(DevTools do not open on a normal launch; they are opt-in via this menu item or a `--devtools` launch flag.)*
  - *(No **View** or **Window** menu: their only deliberate items — Reload File and window close — live in File; standard view items like zoom and full screen are omitted as unused clutter.)*
- *(A searchable command palette is explicitly not built for this version; the native menu covers these operations. The Show/Hide Source view toggle (R4) lives in the title bar rather than the menu.)*

### Help

- **R7. Help window.** A Help window/dialog showing:
  - **Basic app info** — name, version, short description.
  - **License info** — the app's license plus bundled third-party attribution notice (satisfies the main PRD §10 attribution obligation in-app).
  - **Keyboard shortcuts** — a readable reference of all shortcuts (formatting shortcuts, save/force-save, find & replace, print & export-to-PDF R8/R9, menu operations), so the user has an in-app reminder.

### Print & Export to PDF

Both features render **only the active tab's rendered preview** — never the toolbar, tab strip, source editor, split divider, out-of-sync banner, or any open dialog. They share one print stylesheet (`@media print`), since Electron renders both `webContents.print()` and `webContents.printToPDF()` with PRINT media.

- **R8. Export to PDF (`File → Export to PDF…`, `Ctrl/Cmd+Shift+P`).** Writes the active document's rendered preview to a PDF. Export **always** presents a native Save As dialog, pre-filled with a suggested filename and folder; the PDF is written only on explicit confirmation, and canceling writes nothing — the dialog is both a safety catch and a clear indication of where the file lands. The default is the source file's name with a `.pdf` extension (`notes.md` → `notes.pdf`) in **the source file's folder**; with no file open it is `Galley document.pdf` in the user's Documents folder. **Page size Letter, 0.75in margins, backgrounds preserved**; the full document paginates (never clipped to the viewport). Save/IO errors surface as an error dialog, not a crash. *(Priority feature.)*
- **R9. Print (`File → Print…`, `Ctrl/Cmd+P`).** Opens the OS print dialog for the active document's rendered preview, with the same chrome-stripped, full-document, backgrounds-on rendering as R8. Paper, margins, and headers beyond the defaults are the OS dialog's concern.
- **R10. Shared print-rendering rules.** The print stylesheet must: (1) **release the fixed-height scroll chain** (`.app` / `.split-view` / `.pane` / `.preview-scroll` height + overflow) so the whole document flows across pages instead of clipping to the viewport; (2) **hide all non-preview chrome**; (3) **keep backgrounds** (`printBackground: true` plus `print-color-adjust: exact`); (4) apply sensible pagination — avoid breaking inside code blocks / tables, and wrap long code lines and wide tables so they do not run off the page.
- **R11. No new runtime dependencies** — printing and PDF export use Electron's built-in `webContents` APIs (supports the main PRD §5 self-contained goal).
- **R12. Wiring.** The menu handlers run in the main process and call `webContents.print()` / `printToPDF()` directly — printing is main-process work and needs no renderer round-trip. The one fact main lacks, the active document's path (for the save-dialog default), is supplied by a single one-way `setActiveDocPath` signal from the renderer (analogous to `setSourceVisible`). *(IPC follows data ownership: Save / Save-As bounce through the renderer because the buffer and post-write state are renderer-owned; Export reads the live page main already controls and mutates no document state, so it does not.)*
