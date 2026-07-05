/**
 * Keyboard-shortcut reference for the Help window. Kept as pure data,
 * derived from the editor keymap (src/renderer/components/Editor.tsx) and the
 * application menu (src/main/menu.ts), so the Help list and the real bindings
 * stay in step. Formatted per platform (⌘ on macOS, Ctrl elsewhere).
 */
export interface Shortcut {
  /** Key combo, already formatted for the platform. */
  readonly keys: string;
  readonly action: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly items: readonly Shortcut[];
}

// `Ctrl`/`Tab` are literal on every platform — used by the tab-cycle chords,
// which are Control even on macOS (Cmd+Tab is reserved by the OS).
const MAC: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Tab: '⇥' };
const OTHER: Record<string, string> = { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Ctrl: 'Ctrl' };

/** Format a chord (e.g. `'Mod','Shift','X'`) for the platform. */
export function chord(platform: string, ...parts: string[]): string {
  const mac = platform === 'darwin';
  const map = mac ? MAC : OTHER;
  return parts.map((p) => map[p] ?? p).join(mac ? '' : '+');
}

export function shortcutGroups(platform: string): ShortcutGroup[] {
  const k = (...parts: string[]) => chord(platform, ...parts);
  return [
    {
      title: 'File',
      items: [
        { keys: k('Mod', 'O'), action: 'Open file…' },
        { keys: k('Mod', 'S'), action: 'Save (force-save)' },
        { keys: k('Mod', 'R'), action: 'Reload file from disk' },
        { keys: k('Mod', 'P'), action: 'Print' },
        { keys: k('Mod', 'Shift', 'P'), action: 'Export to PDF' },
        { keys: k('Mod', 'W'), action: 'Close tab' },
      ],
    },
    {
      title: 'Tabs',
      items: [
        // Literal Ctrl on every platform — not Mod (⌘), since Cmd+Tab is
        // the macOS app switcher.
        { keys: k('Ctrl', 'Tab'), action: 'Next tab' },
        { keys: k('Ctrl', 'Shift', 'Tab'), action: 'Previous tab' },
      ],
    },
    {
      title: 'Editing',
      items: [
        { keys: k('Mod', 'Z'), action: 'Undo' },
        { keys: `${k('Mod', 'Y')} / ${k('Mod', 'Shift', 'Z')}`, action: 'Redo' },
        { keys: k('Mod', 'F'), action: 'Find & replace' },
      ],
    },
    {
      title: 'Formatting',
      items: [
        { keys: k('Mod', 'B'), action: 'Bold' },
        { keys: k('Mod', 'I'), action: 'Italic' },
        { keys: k('Mod', 'E'), action: 'Inline code' },
        { keys: k('Mod', 'Shift', 'X'), action: 'Strikethrough' },
        { keys: k('Mod', 'Shift', 'C'), action: 'Code block' },
        { keys: `${k('Mod', '1')}–${k('Mod', '6')}`, action: 'Heading level 1–6' },
        { keys: k('Mod', 'K'), action: 'Insert / edit link' },
      ],
    },
    {
      title: 'Lists',
      items: [
        { keys: k('Tab'), action: 'Indent list item' },
        { keys: k('Shift', 'Tab'), action: 'Outdent list item' },
      ],
    },
  ];
}
