# PRD: Galley — Saving & Conflict Handling

**Status:** Draft (split from the main PRD v11, 2026-07-04)
**Companion to:** [`docs/PRD.md`](PRD.md) — the main Galley PRD. This sub-PRD holds the detailed **saving**, **auto-refresh**, and **conflict-handling** requirements; the main PRD's **§6 Features** section indexes it. Requirement IDs (**R#**) are numbered locally within this sub-PRD.

---

## 1. Saving

- **R1.** **Auto-save**, debounced: save **5 seconds after the last keystroke**.
- **R2.** **Force-save** via `Ctrl/Cmd+S`, which saves immediately and bypasses the debounce. *(Auto-save makes this usually a no-op; it is retained intentionally as an explicit, reassuring user action.)*
- **R3.** Accepted tradeoff: an in-flight crash may lose up to ~5 seconds of un-debounced edits. This is acceptable for this tool.
- **R4. Manual reload (`Ctrl/Cmd+R`).** File → Reload File re-reads the open file from disk and loads it fresh, **keeping the current view layout** (split/preview mode, window size, etc.). It reloads only the *document*, never the app. *(The webContents reload / force-reload menu roles are removed and renderer HMR is disabled, so code changes are picked up only by restarting the app — keeping "the file changed" and "the software changed" unambiguously distinct.)*

## 2. Auto-refresh & conflict handling

The governing principle: **both the write path (save) and the read path (load/reload) verify against the last-known on-disk state via a content hash before acting, and neither silently destroys data.** Each open file tracks the hash of its content as of the last successful load or save ("baseline").

- **R5. Watch.** Watch each open file on disk for external changes. *(Main process.)*
- **R6. Self-write detection.** The main process records the hash of content it writes. When the watcher fires, it compares on-disk content against that hash: a match means the app's own save → ignore; a mismatch means a genuine external change. Only genuine external changes are forwarded to the renderer. *(Main process; the renderer only ever hears about real external changes.)*
> **Design frame.** Galley is for turn-based work, not concurrent collaborative editing (main PRD §4): the LLM writes the file and pauses, the user reads and tweaks it, the user tells the LLM, the LLM re-reads. Divergence (disk changing *while* the user holds unsaved edits) is the rare exception. The app does not lock files or editing; its job is to **announce the divergence loudly once** so the user can respond (typically out of band — tell the LLM to stop, or accept the new version), then get out of the way. No sticky "whose-version-wins" latch.

- **R7. Write-path guard (a save lands while disk diverged).** Before auto-save (or force-save) writes, it checks whether the on-disk file still matches the tab's baseline hash. **If disk has diverged** from baseline, do **not** silently overwrite — raise the out-of-sync notice (R9) instead. *(v1 presents the choice as labeled buttons; a rendered diff is out of scope — future: [#84](https://github.com/eschgr/mdtool/issues/84).)*
- **R8. Read-path guard (an external change arrives while the user has work in progress).** When the watcher reports an external change:
  - **If the buffer is in sync and the user has not edited** since it was loaded/last saved, reload silently and update the baseline.
  - **Otherwise** (the user has edits in progress, or the file is already flagged out of sync), raise/update the out-of-sync notice (R9) rather than discarding the work. *(Gated on "has been edited since reconcile", not the momentary dirty flag: a debounced auto-save can briefly clear `dirty`, but an external change just after must still flag — otherwise auto-save would silently downgrade a conflict to an edit-discarding refresh. The flag resets on a deliberate save (Ctrl/Cmd+S) or a reload.)*
- **R9. Out-of-sync notice — two choices, loud once.** When out of sync there are only ever two real choices, presented as two buttons: **Load from disk** (take theirs, discard my edits) or **Keep mine** (overwrite disk with my buffer). The first divergence of a run shows them in a **modal** ("Files are out of sync") so the user notices immediately, and **suspends that tab's auto-save** so nothing is silently overwritten while they decide.
  - **Load from disk** — take the on-disk version and fully reconcile; the loud notice re-arms, so a genuinely new divergence later is loud again.
  - **Keep mine** — force-overwrite disk with the buffer now. The buffer still holds authored content, so if the file diverges **again** (the external writer didn't stop) the notice **re-raises**, but — having already been shown loudly once this run — it recurs as a **passive status-bar flag** (Reload / Keep mine), not another modal. Auto-save stays suspended while flagged. *(Ctrl/Cmd+S while flagged = Keep mine.)*
  - "Loud once per run": the modal appears only on the first divergence after a full reconcile (a load/reload/reopen). After that it's the passive flag, so a still-writing LLM can't turn the notice into a nag. The flag never silently loads disk over the user's version.
  - Rationale: concurrent writes are a non-goal as a *primary* flow (main PRD §4). Earlier drafts offered a third "keep editing / decide later" button, but in use it was indistinguishable from "keep mine" — both just keep the user's buffer — so it was removed. One loud notice, two opposite choices, then a quiet reminder.
- **R10. Watcher debounce.** Debounce the watcher so a rapid sequence of external writes does not cause flicker or repeated prompts.
- **R11. No view locks.** The app does **not** hold a write/exclusive lock on files merely opened for viewing/editing, keeping the window in which two applications contend for the file as small as possible.
