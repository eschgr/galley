/**
 * Keyboard-input → renderer-command mapping for the window's
 * `before-input-event` handler (issue #19 tab cycling, R41 close-tab).
 *
 * Chromium's built-in Ctrl/Cmd+W would close the whole WINDOW and Tab can be
 * swallowed by the focused CM6 editor, so main intercepts these at the input
 * level and asks the renderer to act on the active TAB instead. The pure combo
 * → command decision is lifted out here so it unit-tests without booting
 * Electron (mirrors startupFiles.ts / crashReload.ts); main.ts keeps only the
 * `event.preventDefault()` + `webContents.send(command)` glue.
 */

/** The subset of Electron's `Input` this decision reads (structurally typed so
 *  the real event satisfies it and tests can pass a plain object). */
export interface KeyInput {
  type: string;
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** The renderer IPC channels a key combo can map to. */
export type KeyCommand = 'menu:closeTab' | 'menu:nextTab' | 'menu:prevTab';

/**
 * Map a key-down input to the renderer command it should trigger, or null if
 * the combo isn't one we intercept.
 *
 *  - Close tab: the platform's primary modifier (Cmd on macOS, Ctrl elsewhere)
 *    + `W`, with neither Shift nor Alt held.
 *  - Cycle tabs: literal Ctrl + Tab (→ next), Ctrl+Shift+Tab (→ prev), on every
 *    platform — Cmd+Tab is the OS app-switcher, so Tab always uses Ctrl. Never
 *    when Alt or Cmd (meta) is held.
 *
 * Only `keyDown` events map; anything else (keyUp, etc.) returns null.
 */
export function mapInputToCommand(input: KeyInput, platform: NodeJS.Platform): KeyCommand | null {
  if (input.type !== 'keyDown') return null;

  const closeMod = platform === 'darwin' ? input.meta : input.control;
  if (closeMod && !input.shift && !input.alt && input.key.toLowerCase() === 'w') {
    return 'menu:closeTab';
  }

  if (input.control && !input.alt && !input.meta && input.key === 'Tab') {
    return input.shift ? 'menu:prevTab' : 'menu:nextTab';
  }

  return null;
}
