/**
 * Editor context menu (follow-up to the #119 spell-check). Right-clicking a
 * misspelled word in the source editor offers **spelling suggestions** and **Add to
 * Dictionary**, built over the native spellchecker Electron already runs. Without
 * this handler the squiggles show but the right-click menu has no suggestions
 * (Chromium leaves building that menu to the app).
 *
 * The menu *template* is pure so it's unit-tested without Electron; main.ts turns
 * it into a real menu and pops it.
 *
 * Note: the native checker only supports **persistent add-to-dictionary**, not a
 * session-only "ignore" — so that is the option offered.
 */
import type { MenuItemConstructorOptions } from 'electron';

/** The subset of Electron's context-menu params this menu reads. */
export interface SpellMenuParams {
  /** True when the right-click landed in an editable field (the source editor). */
  readonly isEditable: boolean;
  /** The misspelled word under the cursor, or '' if none. */
  readonly misspelledWord: string;
  /** Dictionary suggestions for that word (may be empty). */
  readonly dictionarySuggestions: readonly string[];
}

export interface SpellMenuActions {
  /** Replace the misspelled word with the chosen suggestion. */
  readonly replace: (suggestion: string) => void;
  /** Add the word to the persistent spellcheck dictionary. */
  readonly addToDictionary: (word: string) => void;
}

/**
 * Build the editor context-menu template. Returns `[]` (show nothing) outside an
 * editable field, preserving today's no-menu behavior in the preview. In the
 * editor it always offers the standard edit actions; when the click landed on a
 * misspelled word, spelling suggestions and **Add to Dictionary** are listed above
 * them.
 */
export function spellMenuTemplate(
  params: SpellMenuParams,
  actions: SpellMenuActions,
): MenuItemConstructorOptions[] {
  if (!params.isEditable) return [];
  const items: MenuItemConstructorOptions[] = [];

  if (params.misspelledWord) {
    if (params.dictionarySuggestions.length > 0) {
      for (const s of params.dictionarySuggestions) {
        items.push({ label: s, click: () => actions.replace(s) });
      }
    } else {
      items.push({ label: 'No spelling suggestions', enabled: false });
    }
    const word = params.misspelledWord;
    items.push(
      { type: 'separator' },
      { label: 'Add to Dictionary', click: () => actions.addToDictionary(word) },
      { type: 'separator' },
    );
  }

  items.push(
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { type: 'separator' },
    { role: 'selectAll' },
  );
  return items;
}
