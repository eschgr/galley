/**
 * Markdown → HTML rendering pipeline (PRD R1–R3).
 *
 * The R5 spike validated this pipeline and settled the math engine; this is the
 * real, reusable preview renderer the preview pane calls.
 *
 * Pieces:
 *  - markdown-it core   → GFM tables + strikethrough (on by default), headings,
 *                         lists, blockquotes, links, images, HR.
 *  - markdown-it-task-lists → GFM `- [ ]` / `- [x]` checkboxes.
 *  - highlight.js       → fenced-code syntax highlighting by info string (R3),
 *                         with a floor: unknown language or a highlight error
 *                         degrades to escaped plain text, never throws.
 *  - markdown-it-texmath (KaTeX engine) → math (R2). Configured for BOTH the
 *                         dollar and bracket delimiter sets, i.e. `$…$`,
 *                         `$$…$$`, `\(…\)`, `\[…\]` — all the styles Claude
 *                         emits. Chosen over @vscode/markdown-it-katex (the
 *                         PRD's rung-1 primary), which renders dollar
 *                         delimiters only; the R5 spike confirmed the gap and
 *                         this is the R6 rung-2 resolution. texmath is
 *                         structure-aware (skips code spans/fences) and its
 *                         dollar guards keep literal `$` in prose from parsing
 *                         as math.
 *
 * R6 floor: KaTeX runs with throwOnError:false, so a malformed formula renders
 * its raw source (in an error color) instead of breaking the whole preview.
 * `renderMarkdown` additionally wraps the whole render so a catastrophic failure
 * in one document degrades to an inline error block rather than a blank page.
 *
 * Security (PRD §3/§7): html:false — raw HTML in the source is NOT passed
 * through. Claude does not emit raw HTML and enabling it would be an injection
 * surface in the renderer.
 */
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js';

const katexOptions = {
  throwOnError: false, // R6 floor: degrade a bad formula to raw source, don't throw
  errorColor: '#d11',
  strict: false as const, // tolerate the looser LaTeX an LLM may emit
};

/**
 * Annotate top-of-block elements with `data-source-line` (the 0-based source
 * line they start at), so the preview can be scroll-anchored to the editor
 * (PRD R18). Mirrors VS Code's markdown-preview technique. Invisible in output;
 * fenced code blocks are rendered by the custom highlighter and are not
 * annotated, but their neighbours are, which is enough to interpolate.
 */
function injectSourceLines(md: MarkdownIt): void {
  md.core.ruler.push('source_line', (state) => {
    for (const token of state.tokens) {
      if (!token.map || !token.block) continue;
      if (token.type.endsWith('_open') || token.nesting === 0) {
        token.attrSet('data-source-line', String(token.map[0]));
      }
    }
  });
}

/**
 * GitHub-compatible heading slug: lowercase, drop punctuation (keep letters of
 * any script, numbers, spaces, hyphens), spaces → hyphens. Matches the anchors
 * an LLM emits for in-document links like `[…](#some-heading)`.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-'); // each whitespace → one hyphen (GitHub does not collapse runs)
}

/**
 * Give each heading an `id` slug so in-page anchor links (`#heading`) have a
 * target to jump to (the preview's click handler scrolls to it). Duplicate slugs
 * get `-1`, `-2`, … like GitHub, so repeated headings stay individually linkable.
 */
function injectHeadingIds(md: MarkdownIt): void {
  md.core.ruler.push('heading_ids', (state) => {
    const seen = new Map<string, number>();
    for (let i = 0; i < state.tokens.length; i++) {
      if (state.tokens[i].type !== 'heading_open') continue;
      const inline = state.tokens[i + 1];
      const base = inline && inline.type === 'inline' ? slugify(inline.content) : '';
      if (!base) continue;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      state.tokens[i].attrSet('id', n === 0 ? base : `${base}-${n}`);
    }
  });
}

function highlightToHtml(code: string, lang: string, md: MarkdownIt): string {
  const escaped = (s: string) => md.utils.escapeHtml(s);
  if (lang && hljs.getLanguage(lang)) {
    try {
      const out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      return `<pre class="hljs"><code class="language-${escaped(lang)}">${out}</code></pre>`;
    } catch {
      /* fall through to the plain-text floor */
    }
  }
  // Floor (R3): unknown language or highlight failure → escaped plain text.
  return `<pre class="hljs"><code>${escaped(code)}</code></pre>`;
}

export function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true, // GFM autolink of bare URLs
    breaks: false,
  });

  // Only autolink text with an explicit scheme (`https://…`, `mailto:…`). Fuzzy
  // linking would turn bare `domain.tld` text into links — and since many file
  // extensions are now real TLDs (`.md` is Moldova, also `.sh`, `.zip`, `.app`…),
  // a filename mentioned in prose like `architecture.md` would wrongly become a
  // clickable link. Explicit `[text](architecture.md)` links still work (R4).
  md.linkify.set({ fuzzyLink: false });

  md.set({ highlight: (str, lang) => highlightToHtml(str, lang, md) });

  md.use(taskLists, { enabled: true, label: true });
  md.use(texmath, {
    engine: katex,
    delimiters: ['dollars', 'brackets'],
    katexOptions,
  });

  injectSourceLines(md);
  injectHeadingIds(md);

  return md;
}

export function renderMarkdown(src: string): string {
  try {
    return createRenderer().render(src);
  } catch (err) {
    // Whole-document floor: never let one document blank the preview.
    const msg = err instanceof Error ? err.message : String(err);
    return `<div class="md-render-error" role="alert"><strong>Render error:</strong> ${msg}</div>`;
  }
}
