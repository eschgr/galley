import { describe, it, expect, vi } from 'vitest';
import { spellMenuTemplate, type SpellMenuActions } from './spellContextMenu';

const actions = (): SpellMenuActions & { replace: ReturnType<typeof vi.fn>; addToDictionary: ReturnType<typeof vi.fn> } => ({
  replace: vi.fn(),
  addToDictionary: vi.fn(),
});

/** Labels of the menu items (separators shown as '---'). */
const labels = (items: ReturnType<typeof spellMenuTemplate>) =>
  items.map((i) => (i.type === 'separator' ? '---' : (i.label ?? i.role ?? '?')));

describe('spellMenuTemplate', () => {
  it('shows no menu outside an editable field', () => {
    expect(spellMenuTemplate({ isEditable: false, misspelledWord: 'teh', dictionarySuggestions: ['the'] }, actions())).toEqual([]);
  });

  it('in the editor with no misspelling, offers only the edit actions', () => {
    const t = spellMenuTemplate({ isEditable: true, misspelledWord: '', dictionarySuggestions: [] }, actions());
    expect(labels(t)).toEqual(['cut', 'copy', 'paste', '---', 'selectAll']);
  });

  it('lists suggestions then Add to Dictionary above the edit actions', () => {
    const t = spellMenuTemplate(
      { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'] },
      actions(),
    );
    expect(labels(t)).toEqual(['the', 'tech', '---', 'Add to Dictionary', '---', 'cut', 'copy', 'paste', '---', 'selectAll']);
  });

  it('shows a disabled "No spelling suggestions" when there are none, but still offers Add to Dictionary', () => {
    const t = spellMenuTemplate({ isEditable: true, misspelledWord: 'asdfg', dictionarySuggestions: [] }, actions());
    expect(labels(t)).toEqual(['No spelling suggestions', '---', 'Add to Dictionary', '---', 'cut', 'copy', 'paste', '---', 'selectAll']);
    expect(t[0].enabled).toBe(false);
  });

  it('wires suggestion clicks to replace(), and Add to Dictionary to addToDictionary()', () => {
    const a = actions();
    const t = spellMenuTemplate({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the'] }, a);
    (t.find((i) => i.label === 'the')!.click as () => void)();
    expect(a.replace).toHaveBeenCalledWith('the');
    (t.find((i) => i.label === 'Add to Dictionary')!.click as () => void)();
    expect(a.addToDictionary).toHaveBeenCalledWith('teh');
  });
});
