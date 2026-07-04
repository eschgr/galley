# PRD: Galley — Opening Files & Instance Model

**Status:** Draft (split from the main PRD v11, 2026-07-04)
**Companion to:** [`docs/PRD.md`](PRD.md) — the main Galley PRD. This sub-PRD holds the detailed **file-opening** and **caller-facing instance-model** requirements; the main PRD's **§5 Features** section indexes it. Requirement IDs (**R#**) are unchanged by the split.

> **Superseded in part by [`docs/PRD-Projects.md`](PRD-Projects.md#1-summary).** The Projects sub-PRD promotes the ephemeral instance model below (**§2, R11–R15**) into a first-class, persistent feature — a durable per-project home, ownership/liveness rework, and session restore. The **caller contract** (a single `galley --project <name> <file>` command; `galley <file>` for a projectless window) is preserved verbatim there; the on-disk home, ownership, liveness, and lifecycle are the Projects sub-PRD's concern.

---

## 1. Opening files

- **R7.** Open a file via **CLI argument**: `galley <file>`.
- **R8.** Open a file via an **in-app file-open dialog** (reachable from the native menu bar).
- **R9.** One file per open action. No multi-file open, no folder view, no drag-and-drop.
- **R10.** The app can start with **no file specified**, opening to an empty "No files open" state (see R46).

## 2. Instance model & file delivery

> **The project model & mechanism live in [`docs/PRD-Projects.md`](PRD-Projects.md#5-concept--what-a-project-is).** This section covers the **caller-facing instance model** — one command, self-arbitration, become-or-hand-off, tab behavior. The project's durable home, ownership/liveness, lifecycle, and session restore are the sub-PRD's; the file-drop transport detail below is retained here.

The app **self-arbitrates per project**. On launch it claims the project named by `--project <name>` and either becomes that project's window or — if a live window already owns the project — hands its files to that window and exits. The caller never probes, coordinates, or speaks any transport; it just runs `galley --project <name> <file>` every time. Arbitration is *per project* (not a global single instance), so each project still gets its own window. The app owns the file-format/liveness logic so the caller's contract is a single command.

- **R11. App self-arbitrates per project (file-drop channel).** On launch with `--project <name>`, the app **claims the project**: with no live owner it **becomes the window** and consumes the channel for delivered files; with a live owner it **drops its files into the channel** (for the existing window to open) and exits. It opens any file given on the command line at startup, and any file later delivered into its channel. *(The project's on-disk home, ownership, and liveness model are the Projects sub-PRD's concern.)*
- **R12. Project keyed by a stable name (not PID).** The `--project <name>` value is the project identity — a stable, filesystem-safe token the caller supplies and reuses across launches. *(PID is only a liveness signal — "is the recorded owner still alive?" — never the identity. How a name maps to the project's home is the sub-PRD's concern.)*
- **R13. App-owned lifecycle (single command).** For a given project the caller always runs the same command — `galley --project <name> <absolute_path>` — and the app decides send-vs-launch:
  1. **Claim** the project.
  2. **If a live owner already exists** → drop the path into its channel; the existing window opens it (or focuses the tab if the file is already open).
  3. **If not** → become the window bound to that project and open the path.
  - Multiple projects ⇒ multiple independent windows, with no global contention. A launch with **no `--project`** opens an independent, projectless window.
- **R14. New file → new tab, focused.** A file delivered to an instance (at launch or over the channel) opens as a **new tab** that receives focus.
- **R15. Already-open file → focus existing tab.** If a delivered file is already open in a tab, the app focuses that existing tab rather than opening a duplicate.

> Implementation note (accepted risk): when a file is delivered to a running instance, **that instance raises/focuses its own window**. An OS generally will not let a *different* process force another process's window to the foreground (Windows especially), so the raise must originate from the receiving instance itself; Windows may still be unreliable here, mitigated with standard tactics (`show()` + `focus()`, brief always-on-top toggle).

> Design note: an earlier **caller-owned** model (the caller probes a socket and decides connect-vs-launch) was **replaced** by this app-self-arbitrating model. The original worry about self-arbitration — losing multi-window project grouping — does not apply, because arbitration is *per project* (one `owner.json` per project), so each project still gets its own window. The switch was driven by two things: (a) a **sandboxed caller cannot `listen()`** on a socket (seatbelt returns EPERM) but can read/write files freely, so a file-drop transport works where a socket does not; and (b) pushing the file-format + liveness logic onto the caller was error-prone — owning it in the app collapses the caller contract to a single command. See the launcher contract in main PRD Appendix A.

> **File-drop transport & addressing (retained).** Behind the main PRD §7 seam (`platform/project.ts`, `channel.ts`, `protocol.ts`, each unit-tested): `owner.json` publishes the owner's `id = <pid>-<startedAt>`; every message/ping filename carries that id, so a message reaches exactly its intended target even if two owners transiently coexist, and a stale owner is inert. A message is a versioned JSON envelope `{ "v", "type": "open", "path" }` written `*.tmp` then atomically renamed `*.msg`; the protocol (`protocol.ts`, independent of the app version) is `MAJOR.MINOR`, and a sender refuses to write to a different-major owner. The owning window opens each delivered path as a focused tab (R14), or focuses the existing tab (R15).
>
> **Current status vs. the rework.** Shipped today, the per-project directory is under the **OS temp dir** and liveness is a `.ping`→`.pong` consumer handshake answered on the main event loop, with release removing the whole directory. The move to a **durable app-managed home**, a **passive OS-maintained lock** (fixing the temp-cleanup duplicate [#60](https://github.com/eschgr/mdtool/issues/60) and the modal-block duplicate [#56](https://github.com/eschgr/mdtool/issues/56)), **non-destructive release**, and **session restore** ([#61](https://github.com/eschgr/mdtool/issues/61)) is designed in the Projects sub-PRD (§7–§10) and not yet built.
