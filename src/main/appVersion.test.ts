import { describe, it, expect, vi } from 'vitest';
import type { IpcMain, App } from 'electron';
import { registerAppVersionIpc, APP_VERSION_CHANNEL } from './appVersion';

// A minimal stand-in for Electron's sync-IPC event (the renderer reads returnValue).
type SyncEvent = { returnValue: unknown };

/** Capture the handler registered via ipcMain.on so we can invoke it directly. */
function fakeIpcMain() {
  const handlers = new Map<string, (event: SyncEvent) => void>();
  const ipcMain = {
    on: vi.fn((channel: string, listener: (event: SyncEvent) => void) => {
      handlers.set(channel, listener);
    }),
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

/** Invoke the registered app:version handler (guarded — no non-null assertion). */
function fireVersion(handlers: Map<string, (event: SyncEvent) => void>, event: SyncEvent) {
  const handler = handlers.get(APP_VERSION_CHANNEL);
  if (!handler) throw new Error(`no handler registered for ${APP_VERSION_CHANNEL}`);
  handler(event);
}

describe('registerAppVersionIpc', () => {
  it('registers a handler on the app:version channel', () => {
    const { ipcMain, handlers } = fakeIpcMain();
    registerAppVersionIpc(ipcMain, { getVersion: () => '1.2.3' });
    expect(ipcMain.on).toHaveBeenCalledWith(APP_VERSION_CHANNEL, expect.any(Function));
    expect(handlers.has(APP_VERSION_CHANNEL)).toBe(true);
  });

  it('answers sendSync with app.getVersion() via event.returnValue', () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const app = { getVersion: vi.fn(() => '0.2.0') } as Pick<App, 'getVersion'>;
    registerAppVersionIpc(ipcMain, app);

    const event: SyncEvent = { returnValue: undefined };
    fireVersion(handlers, event);

    expect(event.returnValue).toBe('0.2.0');
    expect(app.getVersion).toHaveBeenCalledOnce();
  });

  it('reflects whatever version app reports (not a hardcoded literal)', () => {
    const { ipcMain, handlers } = fakeIpcMain();
    registerAppVersionIpc(ipcMain, { getVersion: () => '9.9.9-rc.1' });
    const event: SyncEvent = { returnValue: undefined };
    fireVersion(handlers, event);
    expect(event.returnValue).toBe('9.9.9-rc.1');
  });
});
