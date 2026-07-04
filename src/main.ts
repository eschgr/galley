import { app, BrowserWindow, shell, ipcMain, screen, dialog } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import started from 'electron-squirrel-startup';
import { buildAppMenu } from './main/menu';
import { defaultPdfPath } from './main/pdfName';
import { registerAppVersionIpc } from './main/appVersion';
import { buildCliHelp, wantsHelp } from './main/cliHelp';
import { createPlatformBridge, type SaveResult } from './main/platform';
import { readStartupFiles } from './main/startupFiles';
import { decideStartupAction } from './main/startup';
import { installCliShim, removeCliShim } from './main/cliShim';
import { debounce } from './main/debounce';
import { decideCrashReload, materializeRestore } from './main/crashReload';
import { mapInputToCommand } from './main/keyCommand';
import { computeSourceVisibleBounds } from './main/sourceVisibleBounds';
import { PendingQueue } from './main/pendingQueue';

// Squirrel install/update/uninstall (Windows): besides the Start Menu shortcuts
// that `electron-squirrel-startup` handles, keep the `galley` PATH shim in sync
// (#42). Squirrel runs `Galley.exe --squirrel-<event>` on every version bump, so
// we (re)write the shim to point at THIS exe — `process.execPath` is the current
// versioned `app-x.y.z\Galley.exe`. Best-effort: a shim failure must not block
// install/uninstall. Then the app quits (the Squirrel event isn't a real launch).
if (process.platform === 'win32') {
  const squirrelEvent = process.argv[1];
  try {
    if (squirrelEvent === '--squirrel-install' || squirrelEvent === '--squirrel-updated') {
      installCliShim(process.execPath);
    } else if (squirrelEvent === '--squirrel-uninstall') {
      removeCliShim();
    }
  } catch (err) {
    console.error('[mdtool] galley PATH shim update failed:', err);
  }
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// `--help` / `-h` (issue #38): print the LLM-oriented usage to stdout and exit
// before opening any window. Handled here, as early as possible, so a `galley
// --help` never flashes a window. The text (src/main/cliHelp.ts) is geared at an
// LLM driving the app and mirrors the PRD Appendix A launcher contract.
//
// Caveat: a Windows GUI-subsystem packaged build may not attach to the parent
// console, so stdout can be lost there; it works from a dev launch
// (`npm start -- --help`) and any console-attached invocation.
if (wantsHelp(process.argv)) {
  process.stdout.write(buildCliHelp(app.getVersion()) + '\n');
  app.exit(0);
}

// All OS-touching file work goes through the platform seam (PRD §7/§9). The
// projects-home root (`userData/projects`) is passed as a LAZY thunk: the seam
// stays Electron-free, and `app.getPath` is only read once a project op runs
// (always post-`ready`), never at module load.
const platform = createPlatformBridge({
  projectsHome: () => path.join(app.getPath('userData'), 'projects'),
});

// Files passed on the command line are held here and pulled by the renderer
// on mount via 'file:getStartup' — pulling avoids a race with pushing before the
// renderer has registered its listener. `galley a.md b.md` opens both.
let startupFilePaths: string[] = [];

function targetWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

// Every open file (one per tab) is watched for external changes. The set
// tracks what's currently watched so opens are idempotent and closes unwatch.
const watchedPaths = new Set<string>();

// Watch a file and forward genuine external changes to the renderer (watching
// open files, with self-write detection so our own saves aren't flagged).
// Additive and idempotent — opening more files doesn't stop watching the others.
function watchFile(win: BrowserWindow, absPath: string): void {
  if (watchedPaths.has(absPath)) return;
  watchedPaths.add(absPath);
  platform.watch(absPath, (event) => {
    if (!win.isDestroyed()) win.webContents.send('file:externalChange', event);
  });
}

function unwatchPath(absPath: string): void {
  if (watchedPaths.delete(absPath)) platform.unwatch(absPath);
}

// Read a file, hand it to the renderer to open (from a CLI arg or the file
// dialog), and watch it. Errors
// surface as a dialog rather than crashing the open.
async function openPath(win: BrowserWindow, absPath: string): Promise<void> {
  try {
    const snapshot = await platform.readFile(absPath);
    win.webContents.send('file:opened', snapshot);
    watchFile(win, absPath);
  } catch (err) {
    dialog.showErrorBox('Could not open file', `${absPath}\n\n${String(err)}`);
  }
}

// File → Open…: native dialog, then open the chosen file.
async function openFileViaDialog(): Promise<void> {
  const win = targetWindow();
  if (!win) return;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open markdown file',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths[0]) return;
  await openPath(win, filePaths[0]);
}

// File → Save: the document lives in the renderer, so ask it to save.
function requestSave(): void {
  targetWindow()?.webContents.send('menu:save');
}

// View → Reload File (Ctrl/Cmd+R): ask the renderer to re-read the active tab's
// file from disk and reload it in place — the renderer owns which tab is
// active, so it does the read and keeps the layout/tab.
function requestReload(): void {
  targetWindow()?.webContents.send('menu:reloadFile');
}

// File → Close Tab (Ctrl/Cmd+W): the renderer owns the tabs, so ask it to close
// the active one (prompting if it has unsaved edits).
function requestCloseTab(): void {
  targetWindow()?.webContents.send('menu:closeTab');
}

// Help → Galley Help: the Help window is a renderer modal, so ask it to open.
function requestHelp(): void {
  targetWindow()?.webContents.send('menu:help');
}

// The active document's path per window, mirrored from the renderer purely so
// Export to PDF can default its Save dialog beside the source. This is the
// only renderer→main signal for the print/PDF work — the print itself runs here
// in main (webContents.print / printToPDF), not via a menu round-trip. Multi-
// window safe, like readingWidth above; null on the welcome screen.
const activeDocPath = new Map<number, string | null>();

// App version for the Help window — synchronous `app:version` channel
// returning app.getVersion(); see src/main/appVersion.ts (extracted so the
// handler is unit-testable). The preload exposes it as `window.galley.version`.
registerAppVersionIpc(ipcMain, app);

ipcMain.handle('window:setActiveDocPath', (event, p) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) activeDocPath.set(win.id, typeof p === 'string' ? p : null);
});

// Session persistence (PF19, §8.6): the renderer reports its open-tab set on
// every open/close/switch; persist it to the claimed project's session.json as a
// crash safety net. The write is debounced (~500 ms) so rapid tab churn coalesces
// into one disk write reflecting the settled set; the bridge no-ops in projectless
// mode (no home). Slice A only WRITES — nothing reads session.json back yet.
const SESSION_DEBOUNCE_MS = 500;
const persistSession = debounce((session: { files: string[]; activeIndex: number }) => {
  platform.writeSession(session);
}, SESSION_DEBOUNCE_MS);

ipcMain.handle('window:setSession', (_event, session: unknown) => {
  if (!session || typeof session !== 'object') return;
  const { files, activeIndex } = session as { files?: unknown; activeIndex?: unknown };
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) return;
  persistSession({
    files: files as string[],
    activeIndex: typeof activeIndex === 'number' ? activeIndex : -1,
  });
});

// Session restore (PF20, §8.6): the renderer pulls this once on mount. The bridge
// makes the restore DECISION (dirty shutdown + non-empty open-set + a claimed
// project — else null); here we materialize it, loading each persisted path from
// disk (which re-watches it) so restored content is the last save (D2). A path
// that no longer reads (deleted/moved) is skipped, and `activeIndex` is shifted
// down by each skipped path that preceded it so it still points at the same tab.
// Null decision, or every path unreadable, resolves null → the renderer stays with
// just the CLI files / welcome and shows no prompt.
ipcMain.handle('window:getRestore', async (event) => {
  const decision = platform.getRestoreSession();
  if (!decision) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  // The skip-missing / activeIndex-adjust logic lives in the pure `materializeRestore`
  // helper. `platform.readFile` THROWS on a path that no longer reads; adapt it to
  // the helper's null-for-missing contract, and re-watch each path that loads.
  return materializeRestore(decision, async (absPath) => {
    try {
      const snapshot = await platform.readFile(absPath); // re-watches on read below
      if (win) watchFile(win, absPath);
      return snapshot;
    } catch {
      return null; // no longer reads (deleted/moved since the crash)
    }
  });
});

// File → Print…: open the OS print dialog on the active tab's preview. The
// @media print rules (src/renderer/print.css) strip the chrome and paginate the
// whole document; printBackground pairs with the color-adjust rules.
//
// `silent` is left at its default (false) so the system print dialog appears.
// On Windows 11 (22H2+) that modern OS dialog shows "This app doesn't support
// print preview" in its preview pane for non-UWP surfaces like Electron — the
// dialog is still fully functional (printer, copies, orientation, Print all
// work), that line is just the OS declining to render a live thumbnail.
//
// Fire-and-forget by design — no completion callback. Unlike printToPDF below,
// we cannot surface print failures here: in Electron 42 the print callback's
// failureReason cannot distinguish a user cancel from a real failure. A normal
// cancel reports "Print job canceled" (and "Print job failed" for Microsoft
// Print to PDF on Windows, per electron/electron#36084) — string-identical to a
// genuine failure — so any error box keyed on failureReason would false-alarm on
// every cancel. The OS print dialog reports its own printer errors interactively,
// and it appears without the callback in this Electron version, so dropping the
// callback costs us nothing.
function requestPrint(): void {
  const win = targetWindow();
  if (!win) return;
  win.webContents.print({ printBackground: true });
}

// File → Export to PDF…: always show a native Save dialog pre-filled
// beside the source (or Galley document.pdf in Documents with nothing open).
// Write only on confirm; cancel writes nothing. IO/render errors surface as a
// dialog, never a crash (mirrors the openPath error pattern).
async function requestExportPdf(): Promise<void> {
  const win = targetWindow();
  if (!win) return;
  const def = defaultPdfPath(activeDocPath.get(win.id) ?? null, app.getPath('documents'));
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export to PDF',
    defaultPath: def,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return;
  try {
    const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    await fs.writeFile(filePath, data);
  } catch (err) {
    dialog.showErrorBox('Could not export PDF', `${filePath}\n\n${String(err)}`);
  }
}

// Save path (auto-save, force-save, and the write-path conflict guard): the
// renderer sends content. A `force` write
// overwrites unconditionally ("keep mine"); otherwise it is a checked save that
// refuses to write if disk diverged since we last knew (the write-path guard),
// returning the on-disk snapshot so the renderer can prompt.
ipcMain.handle('file:write', async (_event, args: unknown): Promise<SaveResult> => {
  if (
    !args ||
    typeof args !== 'object' ||
    typeof (args as { path?: unknown }).path !== 'string' ||
    typeof (args as { content?: unknown }).content !== 'string'
  ) {
    throw new Error('file:write requires { path: string, content: string, force?: boolean }');
  }
  const { path: absPath, content, force } = args as {
    path: string;
    content: string;
    force?: boolean;
  };
  if (force === true) {
    const file = await platform.writeFile(absPath, content);
    return { conflict: false, file };
  }
  return platform.saveChecked(absPath, content);
});

// The renderer pulls the command-line files (if any) once on mount. Reads
// each, watches it, and returns the snapshots in command-line order — the
// renderer opens them as tabs and focuses the first. An unreadable path surfaces
// a dialog and is skipped, never fatal to the remaining files.
ipcMain.handle('file:getStartup', async (event) => {
  const paths = startupFilePaths;
  startupFilePaths = []; // pulled once
  const win = BrowserWindow.fromWebContents(event.sender);
  return readStartupFiles(
    paths,
    (absPath) => platform.readFile(absPath),
    (absPath) => {
      if (win) watchFile(win, absPath);
    },
    (absPath, err) => dialog.showErrorBox('Could not open file', `${absPath}\n\n${String(err)}`),
  );
});

// Read a file on demand (manual reload, and opening a file already known to the
// renderer). Updates the baseline hash and (re)watches it. Errors surface as a
// dialog and resolve to null.
ipcMain.handle('file:read', async (event, p: unknown) => {
  if (typeof p !== 'string') return null;
  try {
    const snapshot = await platform.readFile(p);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) watchFile(win, p);
    return snapshot;
  } catch (err) {
    dialog.showErrorBox('Could not read file', `${p}\n\n${String(err)}`);
    return null;
  }
});

// A tab closed: stop watching its file.
ipcMain.handle('file:closed', (_event, p: unknown) => {
  if (typeof p === 'string') unwatchPath(p);
});

// A local-file link clicked in the preview: resolve it relative to the
// source document's folder and open it as a tab. External (web/mail) links go to
// the system browser; in-page anchors are handled in the renderer.
ipcMain.handle('file:openLocal', (event, args: unknown) => {
  if (!args || typeof args !== 'object') return;
  const { href, from } = args as { href?: unknown; from?: unknown };
  if (typeof href !== 'string' || typeof from !== 'string') return;
  const resolved = platform.resolveLocalLink(href, from);
  if (!resolved) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) void openPath(win, resolved);
});

// DevTools do NOT open at startup. Pass --devtools (e.g. `npm run start:devtools`,
// or `galley --devtools` on the packaged app) to open them on launch; otherwise
// use View → Toggle Developer Tools (or F12 / Ctrl+Shift+I) in the menu.
const OPEN_DEVTOOLS = process.argv.includes('--devtools');

// Open a preview link in the system default browser. Renderer requests go
// through here (via the preload bridge) so the renderer never navigates itself.
// Only web/mail schemes are honored; anything else (file:, javascript:, …) is
// refused, so a crafted href cannot launch an arbitrary handler.
ipcMain.handle('shell:openExternal', (_event, url: unknown) => {
  if (typeof url !== 'string') return;
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return;
  }
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') {
    void shell.openExternal(url);
  }
});

// Auto-resize on the Show/Hide Source toggle: showing the source roughly
// doubles the window width to make room for the side-by-side editor; hiding it
// restores the earlier (reading) width. The reading width is remembered per
// window so a user's manual resize is respected. Width is clamped to the display
// work area and the window is nudged to stay fully on-screen; height is kept.
const readingWidth = new Map<number, number>();

ipcMain.handle('window:setSourceVisible', (event, visible: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isFullScreen() || win.isMaximized()) return;
  const show = visible === true;
  const size = win.getSize() as [number, number];
  // On show, remember the current width as the reading width to restore later.
  if (show) readingWidth.set(win.id, size[0]);
  // The doubling / work-area clamp / on-screen nudge is pure — computeSourceVisibleBounds.
  const bounds = computeSourceVisibleBounds({
    size,
    position: win.getPosition() as [number, number],
    workArea: screen.getDisplayMatching(win.getBounds()).workArea,
    reading: readingWidth.get(win.id),
    visible: show,
  });
  win.setBounds(bounds);
});

const createWindow = (project: string | null = null, files: string[] = [], channelId: string | null = null) => {
  const mainWindow = new BrowserWindow({
    // Portrait-ish by default — most documents read better tall than wide.
    // Resizable, so widening for side-by-side editing is one drag away.
    width: 1000,
    height: 1250,
    minWidth: 480,
    minHeight: 480,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security hardening (PRD §7 architecture notes):
      // isolate the renderer from Node and the Electron internals; the only
      // bridge across the boundary is the minimal preload API.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Carry the per-window project name to the preload (PF24). Unlike the
      // app-global version (a sync IPC call), the project differs per window, so
      // it rides in on this window's argv; the preload surfaces it as
      // window.galley.projectName. Omitted (⇒ null) in projectless mode (PF27).
      additionalArguments: project ? [`--galley-project=${project}`] : [],
    },
  });

  // Set once the window is (being) torn down, so the renderer-crash recovery
  // below never reloads a window on its way out — a `render-process-gone` fired
  // during normal close must NOT be treated as a crash to recover from.
  let closing = false;
  mainWindow.on('close', () => {
    closing = true;
  });

  // Stop watching every open file, and close the channel, when the window closes.
  mainWindow.on('closed', () => {
    closing = true;
    for (const p of watchedPaths) platform.unwatch(p);
    watchedPaths.clear();
    activeDocPath.delete(mainWindow.id);
    // Mark this as a CLEAN shutdown (§8.6): drop any pending debounced session
    // write (the final set is already persisted, or there's nothing to persist),
    // then flip the on-disk session's cleanExit flag to true. A whole-app crash
    // never runs this, so `cleanExit:false` surviving to the next launch is the
    // dirty-shutdown signal a later slice reads. No-ops in projectless mode.
    persistSession.cancel();
    platform.markCleanExit();
    void platform.closeChannel();
  });

  // §7 security: links and window.open() from the preview must open in the
  // system browser, never navigate the app's own window or spawn an in-app
  // browser. Anything that is not the app's own page is handed to the OS.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('mailto:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Block in-place navigation away from the app shell (e.g. a clicked link that
  // tries to replace the renderer). Internal dev-server / file loads are allowed.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isInternal =
      (MAIN_WINDOW_VITE_DEV_SERVER_URL && url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL)) ||
      url.startsWith('file:');
    if (!isInternal) {
      event.preventDefault();
      if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('mailto:')) {
        shell.openExternal(url);
      }
    }
  });

  // Ctrl/Cmd+W must close the active TAB, not the window, and Ctrl+Tab /
  // Ctrl+Shift+Tab must cycle tabs — a menu accelerator doesn't
  // reliably override Chromium's built-in window-close, and CM6 can swallow Tab
  // when focused, so intercept at the input level. `mapInputToCommand` owns the
  // pure combo → command decision (unit-tested); here we just swallow the key and
  // forward the command to the renderer.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const command = mapInputToCommand(input, process.platform);
    if (command) {
      event.preventDefault();
      mainWindow.webContents.send(command);
    }
  });

  // Channel (the instance model & file delivery): when this process owns a
  // project (`--project <name>`),
  // open any absolute path the caller drops into the project's channel as a new,
  // focused tab. The app self-arbitrated at startup (this window won the claim);
  // a duplicate launch hands its files here rather than opening another window.
  // Paths arriving before the renderer mounts are queued and flushed on load —
  // `channelQueue` (PendingQueue) owns that queue-then-flush ordering.
  const channelQueue = new PendingQueue<string>();
  const openInWindow = (f: string) => void openPath(mainWindow, f);
  mainWindow.webContents.on('did-finish-load', () => {
    channelQueue.flush(openInWindow);
  });

  // Renderer-crash recovery (PF21, §8.6): if the renderer process dies while main
  // is alive — and it is NOT a normal teardown (`clean-exit`, which fires during
  // ordinary quit) and the window is not already closing — reload the renderer.
  // The reloaded page re-runs its mount flow and hits `getRestore`; session.json
  // is still `cleanExit:false` (only a clean quit flips it), so it offers restore.
  //
  // `decideCrashReload` (a pure, capped helper) drives this: a rolling window of
  // recent reloads with a cap replaces the old single `reloading` flag. That flag
  // was cleared only by `did-finish-load`, so a renderer that crashed AGAIN during
  // the recovery reload (a deterministic mount-time crash) left it stuck `true`
  // forever — every later crash was swallowed and the window stayed blank. The cap
  // instead re-evaluates on EVERY crash: it reloads again (up to RELOAD_CAP within
  // RELOAD_WINDOW_MS), then gives up cleanly rather than loop or hang.
  // (`did-fail-load` is not reliably emitted on a renderer *process* crash, so we
  // deliberately don't re-arm on it.)
  let recentReloads: number[] = [];
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const decision = decideCrashReload({
      reason: details.reason,
      closing,
      destroyed: mainWindow.isDestroyed(),
      recentReloads,
      now: Date.now(),
    });
    recentReloads = decision.recentReloads;
    if (details.reason === 'clean-exit') return; // normal teardown — not a crash
    console.error('[galley] renderer process gone:', details.reason, `(exit ${details.exitCode})`);
    if (decision.gaveUp) {
      console.error('[galley] renderer crashed repeatedly; not reloading again');
      return;
    }
    if (decision.reload) {
      channelQueue.suspend(); // a --project file dropped mid-reload queues instead of dropping
      mainWindow.webContents.reload(); // re-mount → getRestore offers the last session
    }
  });
  // A merely-hung renderer is logged, never auto-reloaded (D2 / §8.6) — reloading a
  // window that might recover on its own would drop unsaved edits gratuitously.
  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[galley] renderer unresponsive');
  });
  if (project && channelId) {
    platform.listenOnChannel(project, channelId, (absPath) => {
      if (mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus(); // the delivered file's tab is focused
      // Open now if the renderer has mounted, else queue for the flush on load.
      channelQueue.deliver(path.resolve(absPath), openInWindow);
    });
  }

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // DevTools are opt-in (--devtools flag) — not auto-opened on a normal launch.
  if (OPEN_DEVTOOLS) {
    console.log('[galley] --devtools set: opening DevTools');
    mainWindow.webContents.openDevTools();
  }

  // Record the command-line files for the renderer to pull on mount.
  startupFilePaths = files;
};

// This method will be called when Electron has finished initialization and is
// ready to create browser windows. Some APIs can only be used after this event.
app.on('ready', async () => {
  buildAppMenu({
    openFile: openFileViaDialog,
    saveFile: requestSave,
    reloadFile: requestReload,
    print: requestPrint,
    exportPdf: requestExportPdf,
    closeTab: requestCloseTab,
    help: requestHelp,
  });

  // Self-arbitration (the instance model & file delivery): with `--project
  // <name>`, claim the project. If a
  // live window already owns it (its pid is alive AND its recorded OS start-time
  // still matches — the start-time liveness check, §8.1/#56), drop our files into
  // its channel and exit rather than open a duplicate; otherwise become its window.
  // A plain launch (no --project) just opens a window with no channel.
  const project = platform.parseCliProjectArg(process.argv, app.isPackaged);
  const files = platform.parseCliFileArgs(process.argv, app.isPackaged);
  if (project) {
    try {
      const claim = await platform.claimProject(project, { appVersion: app.getVersion() });
      const action = decideStartupAction(claim, files);
      if (action.kind === 'handoff') {
        // Address each file to the live owner's channel, then exit (no 2nd window).
        for (const f of action.files) platform.sendToChannel(project, claim.owner.id, f);
        app.quit();
        return;
      }
      if (action.kind === 'incompatible') {
        // A different-major Galley owns this project; writing to it would pollute a
        // queue it can't parse. Surface and exit rather than fail silently (part of
        // the instance model & file delivery).
        dialog.showErrorBox(
          'Galley version mismatch',
          `Another, incompatible version of Galley (channel protocol ${action.ownerProtocol}) already owns ` +
            `project "${project}". Close that window and try again, or open the file with that version.`,
        );
        app.exit(1);
        return;
      }
      createWindow(project, files, claim.owner.id); // we own it — listen on our own channel
    } catch (err) {
      // An unsafe/invalid --project value (e.g. "..", "a/b", an embedded control
      // char) is rejected by the derivation's safe-name guard, which throws here.
      // Surface it cleanly and exit rather than crash the ready handler (mirrors
      // the incompatible-protocol handling above).
      dialog.showErrorBox(
        'Invalid project name',
        `Cannot open project ${JSON.stringify(project)}.\n\n${String(err)}`,
      );
      app.exit(1);
    }
    return;
  }
  createWindow(project, files);
});

// PRD (empty-state / welcome screen): closing the last tab keeps the app open.
// Quitting the whole app is a separate, explicit action. The skeleton keeps the
// default platform behavior for now; window/tab lifecycle is wired up in a
// later step.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS re-create a window when the dock icon is clicked and none are open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// All OS-touching work (file IO + hashing, the file watcher + conflict handling,
// and the per-project file-drop channel) lives behind the platform seam
// (src/main/platform). See PRD §7 (architecture notes) and §9.
