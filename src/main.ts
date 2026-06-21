import { app, BrowserWindow, shell, ipcMain, screen, dialog } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { buildAppMenu } from './main/menu';
import { createPlatformBridge, type SaveResult } from './main/platform';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// All OS-touching file work goes through the platform seam (PRD §7/§9).
const platform = createPlatformBridge();

// A file passed on the command line (R7) is held here and pulled by the renderer
// on mount via 'file:getStartup' — pulling avoids a race with pushing before the
// renderer has registered its listener.
let startupFilePath: string | null = null;

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

// R7: the renderer pulls the command-line file (if any) once on mount.
ipcMain.handle('file:getStartup', async (event) => {
  if (!startupFilePath) return null;
  const absPath = startupFilePath;
  startupFilePath = null;
  try {
    const snapshot = await platform.readFile(absPath);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) watchFile(win, absPath);
    return snapshot;
  } catch (err) {
    dialog.showErrorBox('Could not open file', `${absPath}\n\n${String(err)}`);
    return null;
  }
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

const createWindow = () => {
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

  // Stop watching every open file when the window closes.
  mainWindow.on('closed', () => {
    for (const p of watchedPaths) platform.unwatch(p);
    watchedPaths.clear();
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

  // R7: record a command-line file for the renderer to pull on mount.
  startupFilePath = platform.parseCliFileArg(process.argv, app.isPackaged);
};

// This method will be called when Electron has finished initialization and is
// ready to create browser windows. Some APIs can only be used after this event.
app.on('ready', () => {
  buildAppMenu({
    openFile: openFileViaDialog,
    saveFile: requestSave,
    reloadFile: requestReload,
    closeTab: requestCloseTab,
  });
  createWindow();
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

// Still deferred behind the platform seam (src/main/platform): the file watcher
// + conflict handling (R32–R38) and the per-project channel listener (R11–R15).
// See PRD §7 (architecture notes) and §9.
