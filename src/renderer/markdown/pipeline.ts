/**
 * Markdown → HTML rendering pipeline (PRD R1–R3).
 *
 * This is the candidate preview pipeline the R5 spike validates. It is written
 * as the real, reusable renderer (not throwaway spike code): the preview pane
 * will call `renderMarkdown` once the spike confirms the plugin choices.
 *
 * Pieces:
 *  - markdown-it core   → GFM tables + strikethrough (on by default), headings,
 *                         lists, blockquotes, links, images, HR.
 *  - markdown-it-task-lists → GFM `- [ ]` / `- [x]` checkboxes.
 *  - highlight.js       → fenced-code syntax highlighting by info string (R3),
 *                         with a floor: unknown language or a highlight error
 *                         degrades to escaped plain text, never throws.
 *  - math (R2)          → swappable, to let the spike compare the R6 ladder:
 *      • 'vscode-katex'  = @vscode/markdown-it-katex — KaTeX, `$`/`$$` ONLY
 *                          (the PRD's primary/rung-1 choice).
 *      • 'texmath'       = markdown-it-texmath (KaTeX engine) configured for
 *                          BOTH dollar and bracket delimiter sets, i.e.
 *                          `$…$`, `$$…$$`, `\(…\)`, `\[…\]` (rung-2; covers the
 *                          delimiters Claude actually emits — PRD R2/R6).
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
import katexPlugin from '@vscode/markdown-it-katex';
import katex from 'katex';
import hljs from 'highlight.js';

export type MathEngine = 'vscode-katex' | 'texmath';

/** Default math engine — the rung that covers all of Claude's delimiters. */
export const DEFAULT_MATH_ENGINE: MathEngine = 'texmath';

const katexOptions = {
  throwOnError: false, // R6 floor: degrade a bad formula to raw source, don't throw
  errorColor: '#d11',
  strict: false as const, // tolerate the looser LaTeX an LLM may emit
};

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

export function createRenderer(mathEngine: MathEngine = DEFAULT_MATH_ENGINE): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true, // GFM autolink of bare URLs
    breaks: false,
  });

  md.set({ highlight: (str, lang) => highlightToHtml(str, lang, md) });

  md.use(taskLists, { enabled: true, label: true });

  if (mathEngine === 'vscode-katex') {
    md.use(katexPlugin, { throwOnError: false });
  } else {
    md.use(texmath, {
      engine: katex,
      delimiters: ['dollars', 'brackets'],
      katexOptions,
    });
  }

  return md;
}

export function renderMarkdown(src: string, mathEngine: MathEngine = DEFAULT_MATH_ENGINE): string {
  try {
    return createRenderer(mathEngine).render(src);
  } catch (err) {
    // Whole-document floor: never let one document blank the preview.
    const msg = err instanceof Error ? err.message : String(err);
    return `<div class="md-render-error" role="alert"><strong>Render error:</strong> ${msg}</div>`;
  }
}
