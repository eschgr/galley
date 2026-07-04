/**
 * App-version IPC (the Help window). Registers a synchronous `app:version`
 * channel that returns Electron's `app.getVersion()` — which reads package.json
 * in dev and the packaged app's baked-in version in a release. The preload
 * surfaces this as `window.galley.version`, so Help always shows the real
 * version (it previously fell back to a hardcoded literal in packaged builds,
 * where `process.env.npm_package_version` is absent).
 *
 * Extracted from main.ts so the handler is unit-testable without booting Electron.
 */
import type { IpcMain, App } from 'electron';

export const APP_VERSION_CHANNEL = 'app:version';

export function registerAppVersionIpc(ipcMain: IpcMain, app: Pick<App, 'getVersion'>): void {
  ipcMain.on(APP_VERSION_CHANNEL, (event) => {
    // sendSync contract: the renderer reads `event.returnValue`.
    event.returnValue = app.getVersion();
  });
}
