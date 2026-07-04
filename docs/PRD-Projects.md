# PRD: Galley — Projects

**Status:** Draft v7
**Owner:** (you)
**Last updated:** 2026-07-03
**Companion to:** `docs/PRD.md` (the main Galley PRD). This document owns the **project** concept; where it overlaps the main PRD it **supersedes** those sections (noted in section 2).

---

## 1. Summary

A **project** in Galley is a **named, durable context** for working across a set of markdown files — a stable home for the grouping, workspace state, and cross-file coordination that live *across* files rather than inside any one of them. It is deliberately **not** a folder of files: its content files may live anywhere on disk, may be scattered, and may be shared with other projects.

Today "project" is an ephemeral, main-process-only window-grouping key: `--project <name>` maps to a scratch directory under the OS temp dir that is torn down on close, holds only the liveness record and the file-drop channel, and the renderer has no awareness of it.

This document promotes "project" into a **first-class, persistent concept** with a stable on-disk home, persistent session state, and a robust ownership/liveness model — while keeping the launcher contract the LLM already relies on unchanged, and preserving today's **projectless** behavior when no project is named.

It addresses **GitHub Issue [#62](https://github.com/eschgr/mdtool/issues/62)** (make the project concept genuinely useful) and folds in the ownership/liveness robustness of **[#60](https://github.com/eschgr/mdtool/issues/60)** and **[#56](https://github.com/eschgr/mdtool/issues/56)** and the session-restore gap of **[#61](https://github.com/eschgr/mdtool/issues/61)**. Capabilities explored during design but deferred as out of scope for v1 — because they do not fit the simple project concept — are listed in section 4, each tracked as its own issue.

---

## 2. Relationship to the main PRD

- **Supersedes** the **instance model & file delivery (R11–R15)** in [`PRD-Opening-and-Instances.md`](PRD-Opening-and-Instances.md#2-instance-model--file-delivery): the ephemeral `<tmpdir>/galley-<name>/` scratch dir is replaced by a **durable, app-managed project home** with a runtime/durable split (sections 7 and 8). The *caller contract* — a single `galley --project <name> <file>` command, and a plain `galley <file>` for a projectless window; the app self-arbitrates — is preserved verbatim.
- **Extends** main PRD **section 7 (architecture / portability seam)** with a `ProjectStore` seam member (section 9).
- **Resolves** the main PRD **section 12 open item "Session restore"** (section 6, group C).
- **Leaves unchanged** everything about rendering, editing, saving, conflict handling, tabs, and print/export — a project is context *around* files, not a change to how a file is viewed or edited.

Requirements here are numbered **PF#** (project feature). The numbering is stable across drafts; gaps mark features that were considered and cut (see section 4).

---

## 3. Goals

- Give a project a **stable, durable home** (not the OS temp dir), independent of any running window, requiring **no location choice** from the user.
- Persist and restore **workspace/session state** so a reload or crash does not silently lose the working set.
- Make the **ownership/liveness model robust**: one live window per project under all conditions — never a crash, never a silent duplicate owner, and never mistaking a live-but-busy owner for a dead one.
- **Preserve the launcher contract** (`galley --project <name> <file>`) and today's **projectless** behavior (`galley <file>` → an independent window).
- Keep all OS- and storage-specific work **behind the portability seam** so a future Tauri/Rust shell ports cleanly.

## 4. Non-goals (this version)

Each was considered during design and deliberately cut; each is a candidate future topic.

- **Project instructions / `claude.md`.** Does not fit the LLM's filesystem-anchored context model, and the document files already serve as the LLM-to-human bridge. A future **"managed session"** mode — where the LLM is told a session is Galley-managed and reads Galley's help to organize accordingly — could reintroduce structured project context, but only when a concrete feature needs it; it imposes per-session structure and agreement the base concept should not require. **Tracked in [#69](https://github.com/eschgr/mdtool/issues/69).** *(Was PF10, PF13.)*
- **Cross-project information / a project registry.** Projects are independent and do not know about each other. No shared index, no cross-project settings, no project switcher. *(A future app-level global-settings concept is reasonable but separate from the project concept — **[#70](https://github.com/eschgr/mdtool/issues/70)**.)* *(Was PF4.)*
- **Templating.** Its own future topic that works differently from what a project would model. **Tracked in [#67](https://github.com/eschgr/mdtool/issues/67).** *(Was PF12, PF15.)*
- **Per-project settings surface.** No user-editable project settings; the only candidate (a reading-vs-split default) is not worth a surface. `project.json` holds identity and metadata only. *(Was PF14, PF16, PF17, PF18.)*
- **A curated / tracked member-file list.** Membership is **ephemeral**: a file is associated with a project only while open in that project's session. *(Was PF22.)*
- **New-file creation.** Deferred, bound up with templating. **Tracked in [#68](https://github.com/eschgr/mdtool/issues/68).** *(Was PF23; also the main PRD section 12 item.)*
- **A default project name.** If no `--project` is given, Galley runs **projectless** (PF27), not under an inferred name (e.g. from the current directory). Inferring identity the caller did not ask for is out of scope.
- **Human-driven project creation UI** (a "New Project" dialog with setup questions). The project is created implicitly when files are opened for review (section 8.5); a guided human-initiated flow is a future nicety. **Tracked in [#71](https://github.com/eschgr/mdtool/issues/71).**
- **A "Reveal Home" (or any project-directory) menu affordance.** The durable home is app-managed and not a place the user is expected to visit; when directory access is genuinely needed, the user asks the LLM to open the path or browses to it directly. A dedicated menu item is not worth the surface. *(Was PF26.)*
- **A directory / folder tree view or file browser** in the renderer (consistent with the main PRD section 3).
- **In-tree project homes.** Rejected on principle (section 8.4): a project's context spans directories, so there is no coherent tree to colocate in.

---

## 5. Concept — what a project *is*

Strip away storage and OS. A project has **two clearly separated halves with opposite lifecycles**:

### 5.1 The project (durable, storage-agnostic)

A named context, pure JSON-serializable data plus path references:

- **Identity** — a stable `name` (the `--project` value; also the human-facing label). This is the primary key.
- **Session** — the workspace state (which files are open, the active tab, positions).

The project survives restarts and exists independently of whether any window is currently serving it, and independently of where its content files live.

### 5.2 Ownership (ephemeral runtime binding)

"Which live process currently serves this project's window right now." A fact *about* a project at runtime, **not part of it** — created on launch, dropped on process death, and never touching the durable half. It comprises an **ownership lock** proving a live owner and a **file-drop channel** carrying "open this file" messages to that owner.

### 5.3 Why the split is the design, not just tidiness

The current bugs are lifecycle-coupling bugs. [#60](https://github.com/eschgr/mdtool/issues/60) happens because the durable intent (one persistent owner) and the disposable coordination state share one directory in the reapable temp dir with one delete-on-close lifecycle. Separating the **entity** (5.1) from its **runtime ownership** (5.2) is the model-level fix: durable data can no longer be destroyed by releasing coordination state, and the liveness rework (section 8) operates on the ownership half alone.

### 5.4 The project is emergent

A project is not declared up front; it comes into being at review time. The normal flow: a session starts (in Claude Code or elsewhere), the LLM produces documents, and when they are ready for review they are opened in Galley — at which point the project materializes (PF3). The LLM never has to "think in projects"; its entire interface is the launcher command with a stable name (section 8.5).

---

## 6. Functional requirements — the feature set

### A. Identity & lifecycle

- **PF1. Named identity.** A project is identified by a stable `name` — the launch key and the human-facing label. Names **may contain spaces** (both macOS and Windows allow spaces in file names); they are validated to stay traversal-safe (no path separators, no `.`/`..`, no control characters, no reserved device names). The on-disk home is *derived* from the name (section 8.4) so filesystem edge-cases never leak into the identity.
- **PF2. Durable project home.** Every named project has one durable home directory, **app-managed and derived from the name** (section 8.4) — the user never chooses a location. It hosts all project data and the runtime coordination (section 7 layout).
- **PF3. Materialize-or-reuse.** The first launch for a name creates its home; later launches for the same name reuse it.
- **PF5. One-live-window guarantee.** At most one live window serves a project at a time, enforced by ownership (group B).
- **PF27. Projectless mode.** A launch with no `--project` opens an **independent, ephemeral window**, exactly as today — no home, no persistence, no ownership arbitration, and each instantiation is unique. Projects are strictly opt-in via `--project`. Projectless windows cannot restore after a crash and carry no project context; they are for **fast, throwaway checks**.

### B. Ownership & liveness — the [#56](https://github.com/eschgr/mdtool/issues/56) / [#60](https://github.com/eschgr/mdtool/issues/60) pillar (runtime, disposable)

- **PF6. Passive ownership lock.** A live owner is proven by a signal the **OS** maintains, so it survives the owner's main thread being blocked in a native modal (fixes [#56](https://github.com/eschgr/mdtool/issues/56)) and cannot be faked by a recycled PID (retiring the `.ping`→`.pong` handshake). Mechanism in section 8.1.
- **PF7. Launch liveness test.** On launch the app tests liveness: **live owner ⇒ hand off** its files to that owner and exit; **none ⇒ become owner**. No event-loop acknowledgement required.
- **PF8. Non-destructive release + re-assertion.** Releasing a project clears **only** the runtime coordination state, never durable data. A live owner that detects its home or runtime state was removed out from under it **re-asserts** (recreates the discoverable named artifacts with the same identity) so a later launch hands off rather than duplicating. With the home moved off the temp dir (section 8.4), this is defense-in-depth against rare external deletion, not the primary [#60](https://github.com/eschgr/mdtool/issues/60) fix (section 8.2).
- **PF9. File-drop channel.** "Open this file" messages, addressed to the current owner, delivered as atomically-written files the owning window consumes.

### C. Workspace / session — [#61](https://github.com/eschgr/mdtool/issues/61)'s substance

- **PF19. Session persistence.** The set of open files, the active tab, and positions are persisted as they change.
- **PF20. Session restore.** After a crash or unclean shutdown, a project **offers to reopen** its last saved session; a **clean shutdown starts fresh** (no auto-restore on an ordinary launch). See section 8.6.
- **PF21. Crash / reload handling.** A renderer crash (`render-process-gone` / `unresponsive`) or a whole-app unclean exit is handled deliberately: the renderer is recovered and the crash is surfaced through the restore prompt — never a silent empty view (section 8.6).

### D. Renderer surface — minimal

- **PF24. Project identity in the UI.** A named project's `name` appears in the title bar; a projectless window shows no project.

### E. Operations

- **PF11. Project operations.** The verbs a project supports and how each behaves — see section 8.5.

---

## 7. Data model & on-disk layout

The feature set forces this layout. The **runtime/durable split inside the home** is the model-level fix for [#60](https://github.com/eschgr/mdtool/issues/60). There is no cross-project index — the home is found by deriving it from the name (section 8.4).

```
<home>/                          PF2  the durable project home (app-managed)
  project.json                   PF1  identity + metadata (no user settings)
  session.json                   PF19 open files / active / positions
  runtime/                       ephemeral; release (PF8) clears ONLY this
    owner.json                   PF6-PF8  ownership + liveness record
    *.msg / *.ping               PF9      file-drop channel
```

A projectless window (PF27) has no home and writes none of this.

### 7.1 `project.json` (v1 schema)

A tolerant, versioned record (unknown fields preserved/ignored; missing fields defaulted), mirroring the channel protocol's additive discipline. Deliberately minimal — identity and metadata only, no user settings:

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | number | Format version for forward migration. |
| `name` | string | Identity + display label (spaces allowed). |
| `createdAt` | number | Epoch ms. |
| `appVersion` | string (optional) | App version that created/last-wrote the record (debugging). |

`session.json` is a separately versioned record under the same discipline.

---

## 8. Design detail

### 8.1 Ownership & liveness mechanism (PF6–PF7) — [#56](https://github.com/eschgr/mdtool/issues/56)

**Model:** a passive liveness signal the OS maintains, so it survives a modal-blocked main thread and PID reuse without an ack.

Why the current code did not already do this: **Node has no built-in, cross-platform advisory file lock.** `flock`/`fcntl` are not in Node core, and the npm packages that add them are **native addons**, which the main PRD section 8 rules out (no Rust / no C/C++ build tools). The original channel therefore used a pure-JS PID probe plus a `.ping`→`.pong` file handshake; the handshake is answered on the main-process event loop, which is exactly what a native modal blocks ([#56](https://github.com/eschgr/mdtool/issues/56)).

**Spike outcome** (Phase 2, verified on Windows against the real modal-block repro):

- The **held exclusive handle** is not viable in pure JS: `fs.constants.O_EXLOCK` is **undefined on Windows**, and a Node-held file handle does **not** block another process (Node opens with a permissive share mode and exposes no share-mode control), so there is no lock to hold.
- **`process.kill(pid, 0)` and the OS process start-time are both OS-answered** — no owner code participates — so they stay truthful while the owner's main thread is stuck in a modal. Start-time is readable without a native addon: `wmic process where processid=<pid> get CreationDate` on Windows (present here; a `Get-CimInstance Win32_Process … .CreationDate.ToFileTimeUtc()` fallback if wmic is ever removed), `ps -o lstart= -p <pid>` on macOS.

**Chosen mechanism — start-time-qualified PID liveness, no ack.** An owner in `owner.json` is **live iff `process.kill(pid, 0)` succeeds on this host AND the pid's current OS start-time equals the start-time recorded at claim.** A dead pid (`ESRCH`) or a start-time mismatch ⇒ not live ⇒ take over. This is one cross-platform method; the per-OS **start-time query is the only platform-specific bit**. `kill(0)` removes the ack that caused [#56](https://github.com/eschgr/mdtool/issues/56) (it is OS-answered, so a modal-blocked owner still reads as alive), and the start-time match is the reuse guard the ack used to provide: a recycled pid has a different OS start-time ⇒ treated as dead ⇒ take over, never a phantom handoff. The `.ping`/`.pong` handshake is **retired** — the channel is now messages-only (`.msg`/`.tmp`). Cost: the start-time query runs only on the ambiguous "owner looks alive" path and is bounded (~150 ms `wmic`; ~600 ms CIM fallback); the no-owner and dead-pid paths stay instant. The caller contract is unchanged.

### 8.2 Robustness of the home (PF8) — [#60](https://github.com/eschgr/mdtool/issues/60)

[#60](https://github.com/eschgr/mdtool/issues/60)'s actual trigger is **OS temp-dir cleanup** reaping the scratch dir. Moving the durable home to `userData` (section 8.4) **eliminates that trigger** — `userData` is not temp-swept. Combined with **non-destructive release** (release deletes `runtime/` and nothing else, correcting today's whole-directory `rmSync`), the durable data is safe.

Re-assertion then covers only the rare residual case: an external deletion of the home or `runtime/` while the app runs (a manual delete, a disk cleaner, AV quarantine). Its job is narrow — recreate the discoverable named artifacts so a later launch can *find* the owner; the lock's liveness is inherent to the process, not the file. Detected via the channel watcher's `unlinkDir`/`unlink` events, no polling.

### 8.3 Comingling — files across many projects

Because membership is ephemeral (a file is "in" a project only while open in its session) and content files are decoupled from the home, the same file can be **open in more than one project's window at once**. This is supported by design; the consequences are already covered by existing behavior:

- **Cross-window edits use the existing conflict machinery.** Each window/process independently watches its open files and keeps its own baseline hash. If file `X` is open in window A (project P) and window B (project Q) and A saves, the OS write fires B's watcher; B's self-write detection sees a hash it did not write and treats it as a genuine external change — so B either silently refreshes (if clean) or raises the out-of-sync notice (if it has edits), per main PRD R33/R35. The window-to-window case uses the same "loud once, then passive flag" flow as the LLM-to-human case; no new mechanism.
- **No locks** on files merely opened (main PRD R38), so comingling never blocks.
- **Session restore may reopen a shared file in multiple windows** — consistent with comingling being allowed.
- **Channel routing stays per-project.** `galley --project P X.md` and `galley --project Q X.md` route to different windows by design.

The one thing worth stating plainly: this design makes "two Galley windows editing the same file" a first-class, expected scenario, and the conflict UX serves it as well as it serves LLM-vs-human divergence.

### 8.4 How the home is determined (root determination)

The project home is **never a location the user picks** — Galley derives it deterministically from the project `name`, under the app's `userData` directory:

- Windows: `%APPDATA%/Galley/projects/<derived>/`
- macOS: `~/Library/Application Support/Galley/projects/<derived>/`

This fits both workflows: on macOS, where content lives under a projects parent dir, and on Windows, where Claude Code sessions drop files wherever — because the home is Galley's own bookkeeping, decoupled from where the `.md` files sit. The `name` (supplied by the launcher) is the sole determinant; nothing about the content's disk location is needed, which is why v1 carries no `diskLocation`.

`<derived>` is a deterministic, collision-free, filesystem-safe token computed from the exact `name` (so names with spaces or other characters never produce an invalid or colliding directory); the exact derivation (a sanitized-plus-hash scheme versus a pure hash) is an implementation detail to settle in Phase 1. The human `name` is stored in `project.json` for display.

**Why not in-tree.** Because a project's documents are decoupled from any single folder — scattered across the filesystem and comingled across projects (a file may belong to many projects; a folder may feed many projects) — there is no coherent tree in which to colocate a project home. Colocating would make the context belong to a *directory* rather than to the *project*. So app-managed is not merely convenient; it is the correct home for a context that spans directories.

### 8.5 Project operations (PF11)

The verbs a project supports and how each behaves. The LLM's entire interface is the first two rows via the launcher; the rest are human-facing or lifecycle-internal.

| Operation | Trigger | Behavior |
|---|---|---|
| **Attach / open project** | `galley --project <name> [files]` | Derive and materialize-or-reuse the home; test liveness (PF7). If becoming owner: restore the last session (PF20) and open any CLI files. If a live owner exists: hand off the files and exit. |
| **Open a file into the project** | same command, with a file | Routed via the channel to the owner window as a new focused tab (or focus the tab if already open), per main PRD R14/R15. The opened file joins the ephemeral session. |
| **Update session** | opening/closing/switching tabs | Persist the session record (PF19) as it changes. |
| **Close window** | window close | Persist the final session; release runtime ownership non-destructively (PF8). Durable data is kept. |

There is **no in-app "forget project" operation.** Removing a stale project's home is an out-of-band action — done manually (browse to the home) or via Claude — consistent with there being no cross-project management UI.

### 8.6 Session persistence & crash recovery (PF19–PF21)

Session state is persisted continuously as tabs open, close, and switch (PF19) — purely as a crash safety net, not replayed on an ordinary launch.

Restore is offered **only after a dirty (unclean) shutdown**, detected two ways:

- **Renderer crash, main alive** (`render-process-gone` / `unresponsive`): main recovers the renderer and flags the reload as crash recovery, still holding the exact open-tab list.
- **Whole-app unclean exit** (app crash, power loss, OS kill): a "running" marker written on start and cleared on clean quit is found still set on the next launch; restore comes from the last persisted `session.json`.

A **clean shutdown starts fresh** — no marker, no prompt. On dirty recovery, a concise modal offers restore from the last save, with a **title that marks it as an error** (so it reads as a recovery, not normal operation) and the short question as the body:

> **Galley recovered from a crash**
> Restore session from last save?  [ Yes ] [ No ]

It is an **in-app modal** (like the existing conflict / close-tab dialogs), not a native OS message box — a native box does not display its `title` on macOS, which would drop the error signal on one platform. The "from last save" wording conveys that content past the last auto-save is not carried (main PRD R31's accepted ~5s tolerance). Projectless windows (PF27) have no home and no session, so they cannot restore — by design; they are for fast checks.

---

## 9. Architecture & the portability seam

- **`ProjectStore` seam member.** All project persistence and OS-specific coordination sit behind a new seam interface alongside the existing `platform/` members (`fileIo`, `project`, `channel`, `protocol`). The rest of the main process talks to `ProjectStore` (load/save the entity, derive the home, acquire/release ownership, open/consume the channel), never to Node `fs` or a concrete path layout directly. This is the layer a future Tauri/Rust shell rewrites; the React/CodeMirror/markdown frontend and the project entity (pure data) port as-is.
- **Renderer boundary.** The little project data the renderer needs (PF24) crosses the contextIsolation boundary through additions to the typed `GalleyApi` bridge — the renderer never touches Node or the store directly, consistent with the main PRD section 7 security model.
- **Entity is OS-clean.** The project entity is JSON-serializable data plus path references; the only OS-touching parts (home derivation, the ownership lock, store IO) live in the seam.

---

## 10. Roadmap (phased plan)

Conventions: branch off `main` (the repo default); a unit test ships with every change; the settled design is folded into the PRDs as the first commit of Phase 1; the caller contract and projectless behavior stay fixed throughout.

1. **Phase 1 — Persistent-home foundation** *(recommended first slice).* Introduce the `ProjectStore` seam and the section 7 layout; move the home to `userData` and derive it from the name (section 8.4); relocate ownership + channel under `runtime/`; make **release non-destructive** and add **re-assertion on removal** ([#60](https://github.com/eschgr/mdtool/issues/60)); land the minimal `project.json` (v1); preserve projectless mode (PF27). Today's `.ping`→`.pong` liveness is kept as-is (decoupled from [#56](https://github.com/eschgr/mdtool/issues/56)). No renderer changes. Fully unit-tested behind the seam.
2. **Phase 2 — Liveness rework** *([#56](https://github.com/eschgr/mdtool/issues/56)).* Spike the passive liveness mechanism (section 8.1) on Windows and macOS → adopt it; retire the handshake.
3. **Phase 3 — Session restore** *([#61](https://github.com/eschgr/mdtool/issues/61)).* `session.json` persist/restore (PF19/PF20) + dirty-shutdown crash recovery and the restore prompt (PF21, section 8.6).
4. **Phase 4 — Minimal renderer surface.** Title-bar project identity (PF24); the small `GalleyApi` addition to carry the project name to the renderer.

Phases 2–4 are independent slices with no fixed order; they are sequenced during implementation. Each phase is one or more focused PRs behind the seam, each with tests, each opened for review and merged by you.

---

## 11. Decision log

All design decisions are resolved as of Draft v6.

- **D1 — Physical home location.** App-managed under `userData/projects/<derived>/`, derived from the name (section 8.4). In-tree rejected on principle.
- **D2 — Crash policy (PF21).** Prompt-on-restore, triggered only by a dirty/unclean shutdown (section 8.6); a clean shutdown starts fresh; projectless windows do not restore.
- **D3 — "Forget project" operation.** None. Removing a stale project's home is out-of-band (manual, or via Claude); no in-app operation and no cross-project management UI (section 8.5).
- **D4 — Phase priority.** Not fixed. Phases 2–4 are independent slices, sequenced during implementation.

---

## 12. Traceability

| Issue | Coverage here |
|---|---|
| **[#62](https://github.com/eschgr/mdtool/issues/62)** cross-project information | Refined to its durable core: a persistent, robust project home (PF2) plus session (group C). The seed topics `claude.md`, per-project settings, and templating were explored and cut, with rationale in section 4 (each deferred item tracked as its own issue); cross-project sharing is explicitly a non-goal. |
| **[#60](https://github.com/eschgr/mdtool/issues/60)** owner doesn't survive scratch-dir removal (silent duplicate) | Home moved off temp (8.4), runtime/durable split (section 7), non-destructive release + re-assertion (8.2, PF8). |
| **[#56](https://github.com/eschgr/mdtool/issues/56)** duplicate window when owner blocked by a modal | Passive OS-maintained liveness, no main-thread ack (8.1, PF6–PF7); handshake retired. |
| **[#61](https://github.com/eschgr/mdtool/issues/61)** renderer reload/crash loses tabs (no session restore) | Session persistence/restore + crash handling (PF19–PF21). |

---

## Appendix A — Launcher contract (unchanged)

The LLM-facing contract from the main PRD Appendix A is **preserved verbatim** by this design:

```
galley --project <name> <absolute_file_path>
```

One project maps to one window; the app self-arbitrates (become-or-hand-off); coordination is file-based so it works from a sandboxed shell. A plain `galley <file>` with no `--project` opens an independent, projectless window (PF27), exactly as today. No project-facing additions to the contract are proposed by this design.
