# PRD: Galley — Opening Files & Instance Model

**Status:** Draft

---

## 1. Summary

This sub-PRD covers how files enter Galley and how the app arbitrates a single window per project. Files arrive one of three ways: a CLI argument, the in-app file-open dialog, or an empty start with no file at all. When a caller names a project and passes a file, the app either becomes that project's window or hands the file to the project's live window and exits. The caller runs one command every time — no probing, no coordination, no transport of its own.

## 2. Relationship to the main PRD

- **Serves** the main-PRD goal that Galley "be easy for Claude (or any CLI caller) to drive: a simple command opens a file in the right project window."
- **Complements [`docs/PRD-Projects.md`](PRD-Projects.md#1-summary).** This sub-PRD is the **caller-facing** view of the instance model (§6, R5–R9): the single command, self-arbitration, become-or-hand-off, and delivery to a tab. The **project** those windows belong to — its durable per-project home, the ownership/liveness mechanism, and session persistence — is specified in the Projects sub-PRD. The two describe one model from two angles: the caller contract here, the project's durable internals there.
- **Leaves** the document view and saving to their respective sub-PRDs.

Requirements here are numbered **R#**, local to this sub-PRD.

## 3. Concept

Galley opens the files it is handed — it is not a file manager, so there is no folder browsing or directory tree. A file arrives from a CLI argument, from the in-app file-open dialog, by being **dropped onto the window**, or not at all (the app can start to an empty "No files open" state). The file-open dialog opens one file per action; a drop opens each file it carries.

The instance model is **per-project self-arbitration**. On launch with `--project <name>`, the app claims the project and either becomes its window or drops the file into the live owner's file-drop channel and exits. Identity is a **stable name**, not a PID; the caller's entire contract is a single command. Arbitration is *per project*, so each project still gets its own window, and a launch with **no `--project`** opens an independent, projectless window.

## 4. Goals

- Open a file via a CLI argument, the in-app file dialog, or by dropping it onto the window.
- Start with no file specified (an empty state).
- One window per project, decided by the app through per-project self-arbitration.
- A single-command caller contract that works from a sandbox — the caller never probes, coordinates, or speaks a transport.
- Focus the existing tab when a delivered file is already open.

## 5. Non-goals

- **Directory / folder tree view / file browser** — Galley opens the files it is handed; it is deliberately not a file manager or IDE.
- **"Reveal in Finder/Explorer".**

## 6. Requirements

### Opening files

- **R1.** Open a file via **CLI argument**: `galley <file>`.
- **R2.** Open a file via an **in-app file-open dialog** (reachable from the native menu bar), one file per action.
- **R3. Drag-and-drop open.** Open files by dropping them onto the window. Each dropped file opens through the same read/watch/open path as a CLI argument or the dialog — a new focused tab per file, or focus if it is already open (R8, R9); duplicates within one drop collapse to a single tab. Dropped paths are resolved in the preload (`webUtils.getPathForFile`), since the renderer cannot read `File.path` under contextIsolation. An unreadable drop (e.g. a folder) surfaces an error dialog and is skipped, never fatal to the rest of the drop. *(No folder tree / file browser — see Non-goals.)*
- **R4.** The app can start with **no file specified**, opening to an empty "No files open" state.
- **R4a. Open at a specific line.** A file may be opened positioned at a target line, so a caller that already knows the point of interest sends the reader straight there instead of the top. The canonical CLI form is the familiar editor suffix `galley <file>:<line>` (an optional trailing `:<col>` is accepted and ignored — line-only reveal this version). Parsing splits only a **trailing** `:<digits>` off the path, so a Windows drive letter is never mistaken for a line (`C:\notes.md:120` → the file `C:\notes.md` at line 120; `C:\notes.md` → no line). The line is 1-based and clamped to the file's bounds; the reveal itself (scroll into view with context, brief highlight) is the View sub-PRD's concern ([`PRD-View.md`](PRD-View.md)). Delivery over the channel carries the line as an optional envelope field (R5a). Focusing an already-open file (R9) scrolls that tab to the requested line.

### Instance model & file delivery

> **The project model & mechanism live in [`docs/PRD-Projects.md`](PRD-Projects.md#5-concept--what-a-project-is).** This section covers the **caller-facing instance model** — one command, self-arbitration, become-or-hand-off, tab behavior. The project's durable home, ownership/liveness, lifecycle, and session restore are the Projects sub-PRD's concern.

The app **self-arbitrates per project**. On launch it claims the project named by `--project <name>` and either becomes that project's window or — if a live window already owns the project — hands its files to that window and exits. The caller never probes, coordinates, or speaks any transport; it just runs `galley --project <name> <file>` every time. Arbitration is *per project* (not a global single instance), so each project still gets its own window. The app owns the file-format/liveness logic so the caller's contract is a single command.

- **R5. App self-arbitrates per project (file-drop channel).** On launch with `--project <name>`, the app **claims the project**: with no live owner it **becomes the window** and consumes the channel for delivered files; with a live owner it **drops its files into the channel** (for the existing window to open) and exits. It opens any file given on the command line at startup, and any file later delivered into its channel. *(The project's on-disk home, ownership, and liveness model are the Projects sub-PRD's concern.)*
- **R5a. Channel envelope carries an optional line.** The channel's `open` message envelope (`{ v, type: "open", path }`) gains an optional `line` field. This is an **additive, forward-compatible** change — a **minor** protocol bump: an older owner ignores the unknown field and opens the file at the top, a newer owner reveals the line. The field only ever adds a reveal target; it never changes how the path is delivered. *(The protocol versioning discipline is `protocol.ts`.)*
- **R6. Project keyed by a stable name (not PID).** The `--project <name>` value is the project identity — a stable, filesystem-safe token the caller supplies and reuses across launches. *(PID is only a liveness signal — "is the recorded owner still alive?" — never the identity. How a name maps to the project's home is the sub-PRD's concern.)*
- **R7. App-owned lifecycle (single command).** For a given project the caller always runs the same command — `galley --project <name> <absolute_path>` — and the app decides send-vs-launch:
  1. **Claim** the project.
  2. **If a live owner already exists** → drop the path into its channel; the existing window opens it (or focuses the tab if the file is already open).
  3. **If not** → become the window bound to that project and open the path.
  - Multiple projects ⇒ multiple independent windows, with no global contention. A launch with **no `--project`** opens an independent, projectless window.
- **R8. New file → new tab, focused.** A file delivered to an instance (at launch or over the channel) opens as a **new tab** that receives focus.
- **R9. Already-open file → focus existing tab.** If a delivered file is already open in a tab, the app focuses that existing tab rather than opening a duplicate.
- **R10. Caller manages the tab set (close / replace), not just opens.** The caller contract extends beyond open/focus so a caller can keep the window in step with what it wants shown:
  - **`--close <file…>`** closes the tab(s) for the named path(s) in the project's window. A path that isn't open is a no-op.
  - **`--set <file…>`** makes the open set **exactly** the named files: opens any missing, keeps/focuses those already open, and closes the rest.
  - Both route to the owner window over the channel as new message types (additive, forward-compatible — an older owner ignores an unknown verb). **Closing a tab with unsaved edits still prompts** (Save / Discard / Cancel, per the tab-close behavior), so a caller-driven close never silently discards user work. *(Motivating case: a doc set opened as tabs where two were later merged into one — the caller can now close the stale tabs instead of asking the user to.)*

> Implementation note (accepted risk): when a file is delivered to a running instance, **that instance raises/focuses its own window**. An OS generally will not let a *different* process force another process's window to the foreground (Windows especially), so the raise must originate from the receiving instance itself; Windows may still be unreliable here, mitigated with standard tactics (`show()` + `focus()`, brief always-on-top toggle).

> Why the app self-arbitrates (rather than the caller probing and deciding): a **sandboxed caller cannot `listen()`** on a socket (seatbelt returns EPERM) but can read/write files freely, so a file-drop transport works where a socket does not; and owning the file-format and liveness logic in the app collapses the caller's contract to a single command. See the launcher contract in main PRD Appendix A.

> **The project's durable internals live in [`docs/PRD-Projects.md`](PRD-Projects.md#1-summary).** The durable per-project home, the ownership/liveness mechanism (a passive OS-maintained lock), non-destructive release, and session persistence are specified there (§7–§10). This section covers only the caller-facing contract and delivery behavior.
