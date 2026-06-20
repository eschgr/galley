/**
 * Application menu (start of PRD R47 — native menu bar).
 *
 * Minimal for now: standard role-based File/Edit/View/Window submenus so the OS
 * shortcuts and a "Toggle Developer Tools" item are available. The View submenu
 * is where the user opens DevTools on demand (DevTools no longer auto-opens at
 * startup — see main.ts / the --devtools flag). File's Open/Save and a Help
 * entry are fleshed out in the dedicated menu/Help steps.
 */
import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
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
