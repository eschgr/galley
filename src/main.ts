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

// All OS-touching file work goes through the platform seam (PRD §7/§9).
const platform = createPlatformBridge();

// Files passed on the command line (R7) are held here and pulled by the renderer
// on mount via 'file:getStartup' — pulling avoids a race with pushing before the
// renderer has registered its listener. `mdtool a.md b.md` opens both.
let startupFilePaths: string[] = [];

// Files delivered over the channel (R11) before the renderer has mounted are
// queued here and flushed once the page finishes loading.
const pendingChannelFiles: string[] = [];
let rendererReady = false;

function targetWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

// Every open file (one per tab, R39) is watched for external changes. The set
// tracks what's currently watched so opens are idempotent and closes unwatch.
const watchedPaths = new Set<string>();

// Watch a file and forward genuine external changes to the renderer (R32/R33).
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

// Read a file, hand it to the renderer to open (R7/R8), and watch it. Errors
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

// File → Open… (R8): native dialog, then open the chosen file.
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

// File → Save (R30): the document lives in the renderer, so ask it to save.
function requestSave(): void {
  targetWindow()?.webContents.send('menu:save');
}

// View → Reload File (Ctrl/Cmd+R): ask the renderer to re-read the active tab's
// file from disk and reload it in place (R31a) — the renderer owns which tab is
// active, so it does the read and keeps the layout/tab.
function requestReload(): void {
  targetWindow()?.webContents.send('menu:reloadFile');
}

// File → Close Tab (Ctrl/Cmd+W): the renderer owns the tabs, so ask it to close
// the active one (prompting if it has unsaved edits, R41).
function requestCloseTab(): void {
  targetWindow()?.webContents.send('menu:closeTab');
}

// Help → Galley Help (R48): the Help window is a renderer modal, so ask it to open.
function requestHelp(): void {
  targetWindow()?.webContents.send('menu:help');
}

// The active document's path per window, mirrored from the renderer purely so
// Export to PDF can default its Save dialog beside the source (R52). This is the
// only renderer→main signal for the print/PDF work — the print itself runs here
// in main (webContents.print / printToPDF), not via a menu round-trip. Multi-
// window safe, like readingWidth above; null on the welcome screen.
const activeDocPath = new Map<number, string | null>();

// App version for the Help window (R48) — synchronous `app:version` channel
// returning app.getVersion(); see src/main/appVersion.ts (extracted so the
// handler is unit-testable). The preload exposes it as `window.mdtool.version`.
registerAppVersionIpc(ipcMain, app);

ipcMain.handle('window:setActiveDocPath', (event, p) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) activeDocPath.set(win.id, typeof p === 'string' ? p : null);
});

// File → Print… (R53): open the OS print dialog on the active tab's preview. The
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

// File → Export to PDF… (R52): always show a native Save dialog pre-filled
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

// Save path (R29/R30/R34): the renderer sends content. A `force` write
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

// R7: the renderer pulls the command-line files (if any) once on mount. Reads
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

// Read a file on demand (R31a reload, and opening a file already known to the
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

// A tab closed (R41): stop watching its file.
ipcMain.handle('file:closed', (_event, p: unknown) => {
  if (typeof p === 'string') unwatchPath(p);
});

// A local-file link clicked in the preview (R4): resolve it relative to the
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

// R4: open a preview link in the system default browser. Renderer requests go
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

// Auto-resize on the Show/Hide Source toggle (R45): showing the source roughly
// doubles the window width to make room for the side-by-side editor; hiding it
// restores the earlier (reading) width. The reading width is remembered per
// window so a user's manual resize is respected. Width is clamped to the display
// work area and the window is nudged to stay fully on-screen; height is kept.
const readingWidth = new Map<number, number>();

ipcMain.handle('window:setSourceVisible', (event, visible: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isFullScreen() || win.isMaximized()) return;
  const [w, h] = win.getSize();
  const area = screen.getDisplayMatching(win.getBounds()).workArea;

  let target: number;
  if (visible === true) {
    readingWidth.set(win.id, w);
    target = Math.min(w * 2, area.width);
  } else {
    target = readingWidth.get(win.id) ?? Math.round(w / 2);
  }
  target = Math.round(Math.max(480, Math.min(target, area.width)));

  const [x, y] = win.getPosition();
  let nx = x;
  if (nx + target > area.x + area.width) nx = area.x + area.width - target;
  if (nx < area.x) nx = area.x;
  win.setBounds({ x: Math.round(nx), y, width: target, height: h });
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
    },
  });

  // Stop watching every open file, and close the channel, when the window closes.
  mainWindow.on('closed', () => {
    for (const p of watchedPaths) platform.unwatch(p);
    watchedPaths.clear();
    activeDocPath.delete(mainWindow.id);
    void platform.closeChannel();
  });

  // R4 / §7 security: links and window.open() from the preview must open in the
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

  // Ctrl/Cmd+W must close the active TAB, not the window. A menu accelerator
  // doesn't reliably override Chromium's built-in window-close on this key, so
  // intercept it at the input level, swallow it, and ask the renderer to close
  // the active tab (R41). The last tab closing returns to the welcome screen.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (mod && !input.shift && !input.alt && input.key.toLowerCase() === 'w') {
      event.preventDefault();
      mainWindow.webContents.send('menu:closeTab');
    }
    // Ctrl+Tab / Ctrl+Shift+Tab cycle tabs (issue #19). Always literal Ctrl,
    // even on macOS — Cmd+Tab is reserved by the OS for app switching, and the
    // CM6 editor can swallow Tab when focused, so intercept here. Never fire
    // when Alt or Cmd are held.
    if (input.control && !input.alt && !input.meta && input.key === 'Tab') {
      event.preventDefault();
      mainWindow.webContents.send(input.shift ? 'menu:prevTab' : 'menu:nextTab');
    }
  });

  // Channel (R11–R15): when this process owns a project (`--project <name>`),
  // open any absolute path the caller drops into the project's channel as a new,
  // focused tab. The app self-arbitrated at startup (this window won the claim);
  // a duplicate launch hands its files here rather than opening another window.
  // Paths arriving before the renderer mounts are queued and flushed on load.
  rendererReady = false;
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    for (const f of pendingChannelFiles.splice(0)) void openPath(mainWindow, f);
  });
  if (project && channelId) {
    platform.listenOnChannel(project, channelId, (absPath) => {
      if (mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus(); // R14: the delivered file's tab is focused
      const resolved = path.resolve(absPath);
      if (rendererReady) void openPath(mainWindow, resolved);
      else pendingChannelFiles.push(resolved);
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
    console.log('[mdtool] --devtools set: opening DevTools');
    mainWindow.webContents.openDevTools();
  }

  // R7: record the command-line files for the renderer to pull on mount.
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

  // Self-arbitration (R11–R15): with `--project <name>`, claim the project. If a
  // live window already owns it (confirmed by the channel handshake), drop our
  // files into its channel and exit rather than open a duplicate; otherwise
  // become its window. A plain launch (no --project) just opens a window with no
  // channel.
  const project = platform.parseCliProjectArg(process.argv, app.isPackaged);
  const files = platform.parseCliFileArgs(process.argv, app.isPackaged);
  if (project) {
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
      // queue it can't parse. Surface and exit rather than fail silently (R11–R15).
      dialog.showErrorBox(
        'Galley version mismatch',
        `Another, incompatible version of Galley (channel protocol ${action.ownerProtocol}) already owns ` +
          `project "${project}". Close that window and try again, or open the file with that version.`,
      );
      app.exit(1);
      return;
    }
    createWindow(project, files, claim.owner.id); // we own it — listen on our own channel
    return;
  }
  createWindow(project, files);
});

// PRD R46: closing the last tab keeps the app open. Quitting the whole app is a
// separate, explicit action. The skeleton keeps the default platform behavior
// for now; window/tab lifecycle is wired up in a later step.
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

// All OS-touching work (file IO + hashing, the file watcher + conflict handling
// R32–R38, and the per-project file-drop channel R11–R15) lives behind the
// platform seam (src/main/platform). See PRD §7 (architecture notes) and §9.
