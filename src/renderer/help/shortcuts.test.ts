import { describe, it, expect } from 'vitest';
import { chord, shortcutGroups } from './shortcuts';

describe('shortcut chord formatting (Help, R48)', () => {
  it('uses Ctrl and + joins off macOS', () => {
    expect(chord('win32', 'Mod', 'B')).toBe('Ctrl+B');
    expect(chord('win32', 'Mod', 'Shift', 'X')).toBe('Ctrl+Shift+X');
    expect(chord('linux', 'Shift', 'Tab')).toBe('Shift+Tab');
  });

  it('uses ⌘ symbols with no separator on macOS', () => {
    expect(chord('darwin', 'Mod', 'B')).toBe('⌘B');
    expect(chord('darwin', 'Mod', 'Shift', 'X')).toBe('⌘⇧X');
  });
});

describe('shortcut groups (Help, R48)', () => {
  it('lists the expected groups, each item with keys + action', () => {
    const groups = shortcutGroups('win32');
    expect(groups.map((g) => g.title)).toEqual(['File', 'Editing', 'Formatting', 'Lists']);
    for (const s of groups.flatMap((g) => g.items)) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.action.length).toBeGreaterThan(0);
    }
  });

  it('formats bindings for the platform', () => {
    const items = shortcutGroups('win32').flatMap((g) => g.items);
    expect(items.find((s) => s.action === 'Bold')?.keys).toBe('Ctrl+B');
    expect(items.find((s) => s.action === 'Open file…')?.keys).toBe('Ctrl+O');
    expect(items.find((s) => s.action === 'Heading level 1–6')?.keys).toBe('Ctrl+1–Ctrl+6');

    const mac = shortcutGroups('darwin').flatMap((g) => g.items);
    expect(mac.find((s) => s.action === 'Heading level 1–6')?.keys).toBe('⌘1–⌘6');
  });
});
