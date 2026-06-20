import { app, BrowserWindow, shell, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { buildAppMenu } from './main/menu';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// DevTools do NOT open at startup. Pass --devtools (e.g. `npm run start:devtools`,
// or `mdtool --devtools`) to open them on launch; otherwise use View → Toggle
// Developer Tools (or F12 / Ctrl+Shift+I) in the menu.
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
};

// This method will be called when Electron has finished initialization and is
// ready to create browser windows. Some APIs can only be used after this event.
app.on('ready', () => {
  buildAppMenu();
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

// Main-process feature code (CLI parsing, the channel listener, file IO, file
// watching, hashing) lives behind the platform seam in src/main/platform and is
// wired in here in later steps. See PRD §7 (architecture notes) and §9.
