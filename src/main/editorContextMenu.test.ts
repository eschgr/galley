import { describe, it, expect, vi } from 'vitest';
import { editorContextMenuTemplate, handleEditorContextMenu, type EditorContextMenuActions } from './editorContextMenu';

const actions = (): EditorContextMenuActions & { replace: ReturnType<typeof vi.fn>; addToDictionary: ReturnType<typeof vi.fn> } => ({
  replace: vi.fn(),
  addToDictionary: vi.fn(),
});

/** Labels of the menu items (separators shown as '---'). */
const labels = (items: ReturnType<typeof editorContextMenuTemplate>) =>
  items.map((i) => (i.type === 'separator' ? '---' : (i.label ?? i.role ?? '?')));

describe('editorContextMenuTemplate', () => {
  it('shows no menu outside an editable field', () => {
    expect(editorContextMenuTemplate({ isEditable: false, misspelledWord: 'teh', dictionarySuggestions: ['the'] }, actions())).toEqual([]);
  });

  it('in the editor with no misspelling, offers only the edit actions', () => {
    const t = editorContextMenuTemplate({ isEditable: true, misspelledWord: '', dictionarySuggestions: [] }, actions());
    expect(labels(t)).toEqual(['cut', 'copy', 'paste', '---', 'selectAll']);
  });

  it('lists suggestions then Add to Dictionary above the edit actions', () => {
    const t = editorContextMenuTemplate(
      { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'] },
      actions(),
    );
    expect(labels(t)).toEqual(['the', 'tech', '---', 'Add to Dictionary', '---', 'cut', 'copy', 'paste', '---', 'selectAll']);
  });

  it('shows a disabled "No spelling suggestions" when there are none, but still offers Add to Dictionary', () => {
    const t = editorContextMenuTemplate({ isEditable: true, misspelledWord: 'asdfg', dictionarySuggestions: [] }, actions());
    expect(labels(t)).toEqual(['No spelling suggestions', '---', 'Add to Dictionary', '---', 'cut', 'copy', 'paste', '---', 'selectAll']);
    expect(t[0].enabled).toBe(false);
  });

  it('wires suggestion clicks to replace(), and Add to Dictionary to addToDictionary()', () => {
    const a = actions();
    const t = editorContextMenuTemplate({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the'] }, a);
    (t.find((i) => i.label === 'the')!.click as () => void)();
    expect(a.replace).toHaveBeenCalledWith('the');
    (t.find((i) => i.label === 'Add to Dictionary')!.click as () => void)();
    expect(a.addToDictionary).toHaveBeenCalledWith('teh');
  });
});

describe('handleEditorContextMenu (the main.ts glue, via a fake host)', () => {
  const host = () => ({ replaceMisspelling: vi.fn(), addWordToDictionary: vi.fn(), showMenu: vi.fn() });

  it('does not pop a menu outside an editable field (empty template → no popup)', () => {
    const h = host();
    handleEditorContextMenu({ isEditable: false, misspelledWord: 'teh', dictionarySuggestions: ['the'] }, h);
    expect(h.showMenu).not.toHaveBeenCalled();
  });

  it('pops the editor menu with just the edit actions when nothing is misspelled', () => {
    const h = host();
    handleEditorContextMenu({ isEditable: true, misspelledWord: '', dictionarySuggestions: [] }, h);
    expect(h.showMenu).toHaveBeenCalledTimes(1);
    expect(labels(h.showMenu.mock.calls[0][0])).toEqual(['cut', 'copy', 'paste', '---', 'selectAll']);
  });

  it('maps the params and wires the actions to the host on a misspelled word', () => {
    const h = host();
    handleEditorContextMenu({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'] }, h);
    expect(h.showMenu).toHaveBeenCalledTimes(1);
    const template = h.showMenu.mock.calls[0][0];
    expect(labels(template)).toEqual(['the', 'tech', '---', 'Add to Dictionary', '---', 'cut', 'copy', 'paste', '---', 'selectAll']);
    const click = (label: string) => (template.find((i: { label?: string }) => i.label === label)!.click as () => void)();
    click('the');
    expect(h.replaceMisspelling).toHaveBeenCalledWith('the');
    click('Add to Dictionary');
    expect(h.addWordToDictionary).toHaveBeenCalledWith('teh');
  });
});
