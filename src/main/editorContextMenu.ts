/**
 * The source editor's right-click **context menu**. In the editor it always offers
 * the standard edit actions — Cut / Copy / Paste / Select All — and, when the click
 * landed on a **misspelled word**, prepends that word's **spelling suggestions** and
 * **Add to Dictionary** above them. Outside an editable field it returns nothing, so
 * the preview's right-click behavior is left untouched.
 *
 * The spell section is built over the **native** spellchecker Electron already runs:
 * #119 turned on the squiggles, but Chromium leaves building the menu to the app, so
 * without this a right-click gave no suggestions and no way to add a word. The native
 * checker only supports **persistent add-to-dictionary**, not a session-only
 * "ignore", so that is the option offered.
 *
 * The template *and* the right-click handler (`handleEditorContextMenu`) are pure
 * over an injected host, so both are unit-tested without Electron; main.ts is the
 * humble wrapper that binds the host to the real webContents / session / Menu.
 */
import type { MenuItemConstructorOptions } from 'electron';

/** The subset of Electron's context-menu params this menu reads. */
export interface EditorContextMenuParams {
  /** True when the right-click landed in an editable field (the source editor). */
  readonly isEditable: boolean;
  /** The misspelled word under the cursor, or '' if none. */
  readonly misspelledWord: string;
  /** Dictionary suggestions for that word (may be empty). */
  readonly dictionarySuggestions: readonly string[];
}

export interface EditorContextMenuActions {
  /** Replace the misspelled word with the chosen suggestion. */
  readonly replace: (suggestion: string) => void;
  /** Add the word to the persistent spellcheck dictionary. */
  readonly addToDictionary: (word: string) => void;
}

/**
 * Build the editor context-menu template. Returns `[]` (show nothing) outside an
 * editable field, preserving the preview's no-menu behavior. In the editor it always
 * offers the standard edit actions; when the click landed on a misspelled word,
 * spelling suggestions and **Add to Dictionary** are listed above them.
 */
export function editorContextMenuTemplate(
  params: EditorContextMenuParams,
  actions: EditorContextMenuActions,
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

/**
 * A minimal view of the Electron capabilities the right-click handler needs. main.ts
 * supplies the real `webContents.replaceMisspelling`, `session.addWordToSpellChecker-
 * Dictionary`, and `Menu.buildFromTemplate(...).popup(...)`; tests supply fakes. This
 * is what keeps `handleEditorContextMenu` a pure, testable Humble Object.
 */
export interface ContextMenuHost {
  /** Replace the misspelled word under the cursor with `suggestion`. */
  replaceMisspelling(suggestion: string): void;
  /** Add `word` to the persistent spellcheck dictionary. */
  addWordToDictionary(word: string): void;
  /** Build and show the menu from a (non-empty) template. */
  showMenu(template: MenuItemConstructorOptions[]): void;
}

/**
 * Handle a right-click in the editor: build the template from the event params and
 * show it only when it is non-empty — so a right-click outside an editable field (an
 * empty template) never pops a menu. All Electron access is behind `host`, so the
 * param mapping, the empty-menu gating, and the action wiring are exercised by unit
 * tests; main.ts is the humble wrapper that binds `host` to the real Electron calls.
 */
export function handleEditorContextMenu(params: EditorContextMenuParams, host: ContextMenuHost): void {
  const template = editorContextMenuTemplate(params, {
    replace: (suggestion) => host.replaceMisspelling(suggestion),
    addToDictionary: (word) => host.addWordToDictionary(word),
  });
  if (template.length > 0) host.showMenu(template);
}
