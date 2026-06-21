/**
 * Application menu (PRD R47 — native menu bar).
 *
 * Three app menus (plus the macOS app menu): File (Open/Save/Reload File/Close
 * Tab, all calling back into main), a role-based Edit menu, and Help (the Help
 * window R48 plus Toggle Developer Tools — DevTools never auto-open; they're
 * opt-in here or via the --devtools flag). The View and Window menus are
 * intentionally omitted: their only deliberate items live in File (Reload File,
 * window close), and the rest (zoom / full screen / etc.) was unused clutter.
 */
import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  /** File → Open… (show the open dialog). */
  openFile: () => void;
  /** File → Save (force-save the focused document). */
  saveFile: () => void;
  /** File → Reload File (re-read the open file from disk; keeps the layout). */
  reloadFile: () => void;
  /** File → Close Tab (close the active tab; prompts if it has unsaved edits). */
  closeTab: () => void;
  /** Help → Galley Help (open the Help window, R48). */
  help: () => void;
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
        // Ctrl/Cmd+R re-reads the open file from disk, keeping the view layout
        // (R31a). The webContents reload/forceReload roles are deliberately NOT
        // here — and HMR is off (vite.renderer.config.ts) — so code changes need
        // a restart, never a silent in-place reload. (In File since View was removed.)
        { label: 'Reload File', accelerator: 'CmdOrCtrl+R', click: actions.reloadFile },
        { type: 'separator' },
        // Ctrl/Cmd+W closes the active tab (with an unsaved-edits prompt), not
        // the window. The last tab closing returns to the welcome screen (R41/R46).
        // The accelerator is shown but NOT registered here — the key is captured
        // in main.ts via before-input-event so Chromium's window-close can't fire;
        // registering it too would double-fire. The click still works (mouse).
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', registerAccelerator: false, click: actions.closeTab },
        { type: 'separator' },
        // Window close keeps Cmd+Shift+W on macOS so Cmd+W is free for Close Tab.
        isMac
          ? { role: 'close', label: 'Close Window', accelerator: 'Cmd+Shift+W' }
          : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Galley Help', accelerator: 'F1', click: actions.help },
        { type: 'separator' },
        // Opt-in DevTools (role keeps its F12 / Ctrl+Shift+I / Cmd+Opt+I accelerators).
        { role: 'toggleDevTools' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
