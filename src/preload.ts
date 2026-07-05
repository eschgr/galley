// Preload script — runs in an isolated context with access to a limited set of
// Node/Electron APIs, and is the ONLY place allowed to bridge across the
// contextIsolation boundary into the renderer (security).
//
// It exposes a single frozen object, `window.galley`, typed by GalleyApi. The
// renderer never sees `require`, `ipcRenderer`, or the Node globals directly.
import { contextBridge, ipcRenderer } from 'electron';
import type { GalleyApi, OpenedFile } from './shared/api';
import { parseProjectArg } from './main/projectArg';

// The claimed project name is a PER-WINDOW static — unlike the app-global
// `version`, it differs per window — so it rides in on this window's
// `additionalArguments` (createWindow injects `--galley-project=<name>`), read
// here at load. Its absence (projectless mode) yields null. The parse lives
// in a pure, electron-free helper (src/main/projectArg) so it can be unit-tested.
const projectName = parseProjectArg(process.argv);

const api: GalleyApi = {
  platform: process.platform,
  // App version for the Help window — sourced from main's app.getVersion() (reads
  // package.json in dev / the packaged version in a release), so it tracks every
  // release with no manual edits. sendSync is fine here: one tiny call at load.
  version: ipcRenderer.sendSync('app:version') as string,
  // The claimed project's name for the OS title bar; null projectless.
  projectName,
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  openLocalFile: (href: string, fromPath: string) => {
    void ipcRenderer.invoke('file:openLocal', { href, from: fromPath });
  },
  setSourceVisible: (visible: boolean) => ipcRenderer.invoke('window:setSourceVisible', visible),
  setActiveDocPath: (path) => {
    void ipcRenderer.invoke('window:setActiveDocPath', path);
  },
  setSession: (session) => {
    void ipcRenderer.invoke('window:setSession', session);
  },
  getRestore: () => ipcRenderer.invoke('window:getRestore'),
  saveFile: (filePath: string, content: string, force?: boolean) =>
    ipcRenderer.invoke('file:write', { path: filePath, content, force }),
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
  notifyClosed: (filePath: string) => {
    void ipcRenderer.invoke('file:closed', filePath);
  },
  getStartupFiles: () => ipcRenderer.invoke('file:getStartup'),
  onOpenFile: (callback: (file: OpenedFile) => void) => {
    const listener = (_event: unknown, file: OpenedFile) => callback(file);
    ipcRenderer.on('file:opened', listener);
    return () => ipcRenderer.removeListener('file:opened', listener);
  },
  onMenuSave: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:save', listener);
    return () => ipcRenderer.removeListener('menu:save', listener);
  },
  onReloadFile: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:reloadFile', listener);
    return () => ipcRenderer.removeListener('menu:reloadFile', listener);
  },
  onCloseTab: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:closeTab', listener);
    return () => ipcRenderer.removeListener('menu:closeTab', listener);
  },
  onNextTab: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:nextTab', listener);
    return () => ipcRenderer.removeListener('menu:nextTab', listener);
  },
  onPrevTab: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:prevTab', listener);
    return () => ipcRenderer.removeListener('menu:prevTab', listener);
  },
  onHelp: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:help', listener);
    return () => ipcRenderer.removeListener('menu:help', listener);
  },
  onExternalChange: (callback: (file: OpenedFile) => void) => {
    const listener = (_event: unknown, file: OpenedFile) => callback(file);
    ipcRenderer.on('file:externalChange', listener);
    return () => ipcRenderer.removeListener('file:externalChange', listener);
  },
  onCloseFile: (callback: (path: string) => void) => {
    const listener = (_event: unknown, path: string) => callback(path);
    ipcRenderer.on('file:close', listener);
    return () => ipcRenderer.removeListener('file:close', listener);
  },
  onRetainFiles: (callback: (paths: string[]) => void) => {
    const listener = (_event: unknown, paths: string[]) => callback(paths);
    ipcRenderer.on('file:retain', listener);
    return () => ipcRenderer.removeListener('file:retain', listener);
  },
};

contextBridge.exposeInMainWorld('galley', api);
