# PRD: Galley — Saving & Conflict Handling

**Status:** Draft

---

## 1. Summary

How edits persist and how Galley stays consistent with the file on disk. Edits auto-save on a short debounce, with an explicit force-save as reassurance. Open files are watched for external changes, and both the write path (save) and the read path (load/reload) verify against a content-hash baseline before acting, so nothing is silently overwritten or discarded. When the disk and the user's buffer genuinely diverge, Galley announces it loudly once, then quietly, and offers exactly two choices.

## 2. Relationship to the main PRD

- **Serves** the main-PRD goal "auto-refresh open files when they change on disk," together with the auto-save workflow that keeps edits persisted without manual saving.
- **Builds on** the product-level framing that concurrent LLM editing is not a primary flow ([`PRD.md`](PRD.md) §4): divergence is treated as the rare exception, not the common case.
- **Leaves unchanged** the document view ([`PRD-View.md`](PRD-View.md)), and the tab/shell surface ([`PRD-UI-Shell.md`](PRD-UI-Shell.md)).

Requirements here are numbered **R#**, local to this sub-PRD.

## 3. Concept

Galley is for **turn-based** work: the LLM writes the file and pauses, the user reads and tweaks it, the user tells the LLM, the LLM re-reads. Divergence — the disk changing *while* the user holds unsaved edits — is the rare exception, not the working mode. The app does not lock files or editing; its job is to notice divergence and get out of the way.

Both the **write path** (save) and the **read path** (load/reload) check the current on-disk state against the tab's last-known baseline hash before acting, and **neither silently destroys data**. Each open file tracks the hash of its content as of the last successful load or save, and only genuine external changes — not the app's own writes — ever reach the renderer.

When the disk and buffer do diverge, the app announces it **loudly once** (a modal), then quietly (a status-bar flag), suspends that tab's auto-save until resolved, and offers exactly two opposite choices: **Load from disk** (take theirs) or **Keep mine** (overwrite disk). There is no sticky "whose-version-wins" latch and no third "decide later" option.

A related case is the file **disappearing** — moved or deleted on disk while a tab holds it open. That is not a content conflict but an absence, so it gets its own passive, non-destructive treatment (the buffer is preserved, the tab is marked orphaned, and the user relocates via Save As) rather than the loud conflict modal — see the "file gone" requirements below.

## 4. Goals

- Auto-save without nagging, with an explicit force-save retained as a reassuring user action.
- Never lose data to a conflict — neither the write path nor the read path silently overwrites or discards.
- Forward only genuine external changes to the renderer; ignore the app's own writes.
- Hold no view or exclusive locks on files opened for viewing/editing.
- On divergence, announce loudly once (modal), then quietly (status-bar flag), suspending auto-save until the user resolves it.

## 5. Non-goals

- **Concurrent collaborative editing** as a primary flow — Galley targets turn-based work ([`PRD.md`](PRD.md) §4); it does not lock files or arbitrate simultaneous writers.
- **Crash-proof / zero-loss durability** — an in-flight crash may lose up to ~5 seconds of un-debounced edits. Acceptable for this tool.
- **A "decide later" / third resolution option** — deliberately not offered; in use it was indistinguishable from "keep mine", so the notice offers exactly two opposite choices.

## 6. Requirements

### Saving

- **R1.** **Auto-save**, debounced: save **5 seconds after the last keystroke**.
- **R2.** **Force-save** via `Ctrl/Cmd+S`, which saves immediately and bypasses the debounce. *(Auto-save makes this usually a no-op; it is retained intentionally as an explicit, reassuring user action.)*
- **R2a. Atomic saves.** A save is **all-or-nothing**: any concurrent reader — the file watcher or an external editor — only ever sees the complete previous file or the complete new file, never a half-written or truncated state, and a crash mid-save must not corrupt the document. *(This is also what keeps self-write detection (R5) reliable — every on-disk read the watcher sees is a full, recorded content, never a torn one that looks like an external change.)*
- **R3. Manual reload (`Ctrl/Cmd+R`).** File → Reload File re-reads the open file from disk and loads it fresh, **keeping the current view layout** (split/preview mode, window size, etc.). It reloads only the *document*, never the app. *(The webContents reload / force-reload menu roles are removed and renderer HMR is disabled, so code changes are picked up only by restarting the app — keeping "the file changed" and "the software changed" unambiguously distinct.)*

### Auto-refresh & conflict handling

- **R4. Watch.** Watch each open file on disk for external changes. *(Main process.)*
- **R5. Self-write detection.** The main process records the hash of content it writes. When the watcher fires, it compares on-disk content against that hash: a match means the app's own save → ignore; a mismatch means a genuine external change. Only genuine external changes are forwarded to the renderer. *(Main process; the renderer only ever hears about real external changes.)*

- **R6. Write-path guard (a save lands while disk diverged).** Before auto-save (or force-save) writes, it checks whether the on-disk file still matches the tab's baseline hash. **If disk has diverged** from baseline, do **not** silently overwrite — raise the out-of-sync notice (R8) instead. *(v1 presents the choice as labeled buttons.)*
- **R7. Read-path guard (an external change arrives while the user has work in progress).** When the watcher reports an external change:
  - **If the buffer is in sync and the user has not edited** since it was loaded/last saved, reload silently and update the baseline.
  - **Otherwise** (the user has edits in progress, or the file is already flagged out of sync), raise/update the out-of-sync notice (R8) rather than discarding the work. *(Gated on "has been edited since reconcile", not the momentary dirty flag: a debounced auto-save can briefly clear `dirty`, but an external change just after must still flag — otherwise auto-save would silently downgrade a conflict to an edit-discarding refresh. The flag resets on a deliberate save (Ctrl/Cmd+S) or a reload.)*
- **R8. Out-of-sync notice — two choices, loud once.** When out of sync there are only ever two real choices, presented as two buttons: **Load from disk** (take theirs, discard my edits) or **Keep mine** (overwrite disk with my buffer). The first divergence of a run shows them in a **modal** ("Files are out of sync") so the user notices immediately, and **suspends that tab's auto-save** so nothing is silently overwritten while they decide.
  - **Load from disk** — take the on-disk version and fully reconcile; the loud notice re-arms, so a genuinely new divergence later is loud again.
  - **Keep mine** — force-overwrite disk with the buffer now. The buffer still holds authored content, so if the file diverges **again** (the external writer didn't stop) the notice **re-raises**, but — having already been shown loudly once this run — it recurs as a **passive status-bar flag** (Reload / Keep mine), not another modal. Auto-save stays suspended while flagged. *(Ctrl/Cmd+S while flagged = Keep mine.)*
  - "Loud once per run": the modal appears only on the first divergence after a full reconcile (a load/reload/reopen). After that it's the passive flag, so a still-writing LLM can't turn the notice into a nag. The flag never silently loads disk over the user's version.
  - Rationale: concurrent writes are a non-goal as a *primary* flow (main PRD §4). Earlier drafts offered a third "keep editing / decide later" button, but in use it was indistinguishable from "keep mine" — both just keep the user's buffer — so it was removed. One loud notice, two opposite choices, then a quiet reminder.
- **R9. Watcher debounce.** Debounce the watcher so a rapid sequence of external writes does not cause flicker or repeated prompts.
- **R10. No view locks.** The app does **not** hold a write/exclusive lock on files merely opened for viewing/editing, keeping the window in which two applications contend for the file as small as possible.

### File moved or deleted on disk ("file gone")

The guards above cover *diverged content* — the file still exists but its bytes changed. A separate case is the file **vanishing**: moved or deleted out from under an open tab (typically during a project reorganization). Left unhandled the tab shows stale content with no signal, and a later save could silently re-create the file at the old, now-wrong path. The response mirrors the conflict philosophy — **never lose the buffer, tell the user, offer safe choices** — but stays **passive** (no modal), because a bulk reorg removes many files at once and a modal per file would be a storm.

- **R11. Detect removal.** The watcher detects an open file being removed — chokidar's `unlink`, plus the read-failure path (a change fires but the file no longer reads) — and forwards a **removal event** to the renderer, alongside the existing external-change event. A move/rename surfaces as removal at the old path (the new location generally can't be followed); it is treated as "gone", and the user relocates. *(Following a same-directory rename by pairing unlink+add is a possible later refinement, not the baseline.)*
- **R12. Orphaned tab — preserve the buffer, passive banner.** A tab whose file was removed is marked **orphaned** and shows a **passive per-tab banner** ("This file was moved or deleted on disk"), never a modal. The **buffer is preserved in full** — unsaved edits are never discarded — and the tab stays open. The banner offers exactly the safe choices: **Save As…** (relocate the document to a new path), **Keep open** (dismiss the banner; keep the buffer in memory), and **Close** (close the tab, prompting to save first if it has unsaved edits). Auto-save is suspended for an orphaned tab (there is no valid path to write). *(The passive-only treatment is the deliberate divergence from R8's loud-once modal: bulk removals must not storm.)*
- **R13. Guard save on an orphaned tab.** A normal save (auto-save or `Ctrl/Cmd+S`) on an orphaned tab must **not** silently re-create the file at the old path. It is routed to **Save As…** instead, so the user chooses where the relocated document lands. A successful Save As adopts the new path, re-watches it, clears the orphaned state, and the tab resumes ordinary saving. **Bulk resilience:** many rapid removals coalesce into per-tab flags (R12), never a burst of dialogs.
