import { describe, it, expect } from 'vitest';
import { mapInputToCommand, type KeyInput } from './keyCommand';

// A keyDown input with no modifiers; spread to set the combo under test.
const keyDown = (over: Partial<KeyInput>): KeyInput => ({
  type: 'keyDown',
  key: '',
  control: false,
  shift: false,
  alt: false,
  meta: false,
  ...over,
});

describe('mapInputToCommand — close tab (Ctrl/Cmd+W, R41)', () => {
  it('maps Ctrl+W to close-tab on win32/linux', () => {
    expect(mapInputToCommand(keyDown({ key: 'w', control: true }), 'win32')).toBe('menu:closeTab');
    expect(mapInputToCommand(keyDown({ key: 'w', control: true }), 'linux')).toBe('menu:closeTab');
  });

  it('maps Cmd+W (meta) to close-tab on darwin, and Ctrl+W does NOT', () => {
    expect(mapInputToCommand(keyDown({ key: 'w', meta: true }), 'darwin')).toBe('menu:closeTab');
    // On macOS the close modifier is Cmd, so a literal Ctrl+W is not close-tab.
    expect(mapInputToCommand(keyDown({ key: 'w', control: true }), 'darwin')).toBeNull();
  });

  it('is case-insensitive on the W key (Shift-less capital reported as W)', () => {
    // Shift makes it not-close (below); but a bare capital W with no shift maps.
    expect(mapInputToCommand(keyDown({ key: 'W', control: true }), 'win32')).toBe('menu:closeTab');
  });

  it('ignores Shift+W and Alt+W (only bare mod+W closes)', () => {
    expect(mapInputToCommand(keyDown({ key: 'w', control: true, shift: true }), 'win32')).toBeNull();
    expect(mapInputToCommand(keyDown({ key: 'w', control: true, alt: true }), 'win32')).toBeNull();
  });

  it('does not close on W with no modifier', () => {
    expect(mapInputToCommand(keyDown({ key: 'w' }), 'win32')).toBeNull();
  });
});

describe('mapInputToCommand — cycle tabs (Ctrl+Tab / Ctrl+Shift+Tab, #19)', () => {
  it('maps Ctrl+Tab to next and Ctrl+Shift+Tab to prev', () => {
    expect(mapInputToCommand(keyDown({ key: 'Tab', control: true }), 'win32')).toBe('menu:nextTab');
    expect(mapInputToCommand(keyDown({ key: 'Tab', control: true, shift: true }), 'win32')).toBe('menu:prevTab');
  });

  it('uses literal Ctrl even on darwin (Cmd+Tab is the OS app-switcher)', () => {
    expect(mapInputToCommand(keyDown({ key: 'Tab', control: true }), 'darwin')).toBe('menu:nextTab');
    // Cmd+Tab (meta) must NOT be intercepted.
    expect(mapInputToCommand(keyDown({ key: 'Tab', meta: true }), 'darwin')).toBeNull();
  });

  it('never fires when Alt or Meta is held with Ctrl+Tab', () => {
    expect(mapInputToCommand(keyDown({ key: 'Tab', control: true, alt: true }), 'win32')).toBeNull();
    expect(mapInputToCommand(keyDown({ key: 'Tab', control: true, meta: true }), 'win32')).toBeNull();
  });

  it('does not cycle on Tab with no modifier', () => {
    expect(mapInputToCommand(keyDown({ key: 'Tab' }), 'win32')).toBeNull();
  });
});

describe('mapInputToCommand — non-mapping inputs', () => {
  it('returns null for any non-keyDown event (e.g. keyUp)', () => {
    expect(mapInputToCommand(keyDown({ type: 'keyUp', key: 'w', control: true }), 'win32')).toBeNull();
    expect(mapInputToCommand(keyDown({ type: 'keyUp', key: 'Tab', control: true }), 'win32')).toBeNull();
  });

  it('returns null for an unmapped key', () => {
    expect(mapInputToCommand(keyDown({ key: 'a', control: true }), 'win32')).toBeNull();
  });
});
