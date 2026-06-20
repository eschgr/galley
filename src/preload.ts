// Preload script — runs in an isolated context with access to a limited set of
// Node/Electron APIs, and is the ONLY place allowed to bridge across the
// contextIsolation boundary into the renderer. See PRD §7 (security).
//
// It exposes a single frozen object, `window.mdtool`, typed by MdtoolApi. The
// renderer never sees `require`, `ipcRenderer`, or the Node globals directly.
import { contextBridge, ipcRenderer } from 'electron';
import type { MdtoolApi } from './shared/api';

const api: MdtoolApi = {
  platform: process.platform,
  version: process.env.npm_package_version ?? '0.1.0',
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
};

contextBridge.exposeInMainWorld('mdtool', api);
