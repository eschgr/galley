/**
 * Application menu (PRD R47 — native menu bar).
 *
 * File → Open (R8) and Save (R30) call back into main; the rest is standard
 * role-based Edit/View/Window submenus. The View submenu is where the user opens
 * DevTools on demand (DevTools no longer auto-opens at startup — see main.ts /
 * the --devtools flag). The Help entry is fleshed out in the Help step (R48).
 */
import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  /** File → Open… (show the open dialog). */
  openFile: () => void;
  /** File → Save (force-save the focused document). */
  saveFile: () => void;
  /** View → Reload File (re-read the open file from disk; keeps the layout). */
  reloadFile: () => void;
  /** File → Close Tab (close the active tab; prompts if it has unsaved edits). */
  closeTab: () => void;
}

export function buildAppMenu(actions: MenuActions): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: actions.openFile },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: actions.saveFile },
        { type: 'separator' },
        // Ctrl/Cmd+W closes the active tab (with an unsaved-edits prompt), not
        // the window. The last tab closing returns to the welcome screen (R41/R46).
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: actions.closeTab },
        { type: 'separator' },
        // Window close keeps Cmd+Shift+W on macOS so Cmd+W is free for Close Tab.
        isMac
          ? { role: 'close', label: 'Close Window', accelerator: 'Cmd+Shift+W' }
          : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // Ctrl/Cmd+R reloads the open *file* from disk (keeping the view layout),
        // not the renderer. The webContents reload/forceReload roles are
        // deliberately omitted — and HMR is off (vite.renderer.config.ts) — so
        // code changes are picked up by restarting the app, never silently.
        { label: 'Reload File', accelerator: 'CmdOrCtrl+R', click: actions.reloadFile },
        { type: 'separator' },
        { role: 'toggleDevTools' }, // user-facing way to open DevTools
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
