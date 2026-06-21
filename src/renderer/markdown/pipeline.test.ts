import { describe, it, expect } from 'vitest';
import { renderMarkdown, slugify } from './pipeline';

describe('heading anchor slugs (in-page links)', () => {
  it('slugifies like GitHub — lowercase, punctuation dropped, spaces to hyphens', () => {
    expect(slugify('Clothing: what the scroll images show')).toBe('clothing-what-the-scroll-images-show');
    expect(slugify('Age & gender (overview)')).toBe('age--gender-overview');
    expect(slugify('  Trimmed  Spaces  ')).toBe('trimmed--spaces');
  });

  it('keeps non-Latin letters (e.g. CJK)', () => {
    expect(slugify('清明 festival')).toBe('清明-festival');
  });

  it('gives headings an id matching the link target', () => {
    const html = renderMarkdown('## Clothing: what the scroll images show');
    expect(html).toContain('id="clothing-what-the-scroll-images-show"');
  });

  it('de-duplicates repeated headings like GitHub (-1, -2)', () => {
    const html = renderMarkdown('# Notes\n\n# Notes\n\n# Notes');
    expect(html).toContain('id="notes"');
    expect(html).toContain('id="notes-1"');
    expect(html).toContain('id="notes-2"');
  });
});

describe('autolinking (linkify) — schemes only, not bare filenames', () => {
  it('does NOT autolink a bare filename whose extension is also a TLD', () => {
    // `.md` is Moldova's TLD; fuzzy linking would wrongly turn this into a link.
    const html = renderMarkdown('See architecture.md for the design.');
    expect(html).not.toContain('<a ');
  });

  it('still autolinks a bare URL that has an explicit scheme', () => {
    const html = renderMarkdown('Docs at https://example.com/page here.');
    expect(html).toContain('href="https://example.com/page"');
  });

  it('keeps explicit links to local files clickable', () => {
    const html = renderMarkdown('[the design](architecture.md)');
    expect(html).toContain('href="architecture.md"');
  });
});

describe('GFM rendering (R1)', () => {
  it('renders tables', () => {
    const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table'); // may carry a data-source-line attribute
    expect(html).toContain('<td>1</td>');
  });

  it('renders task-list checkboxes, checked and unchecked', () => {
    const html = renderMarkdown('- [x] done\n- [ ] todo');
    const boxes = html.match(/<input[^>]*type="checkbox"/g) ?? [];
    expect(boxes.length).toBe(2);
    expect(html).toContain('checked'); // the [x] item
  });

  it('renders strikethrough', () => {
    expect(renderMarkdown('~~gone~~')).toContain('<s>gone</s>');
  });

  it('autolinks bare URLs', () => {
    expect(renderMarkdown('see https://example.com here')).toContain('href="https://example.com"');
  });
});

describe('math delimiters (R2)', () => {
  it('renders inline dollar math', () => {
    expect(renderMarkdown('the value $a^2 + b^2$ here')).toMatch(/class="katex/);
  });

  it('renders block dollar math', () => {
    expect(renderMarkdown('$$\\int_0^1 x\\,dx$$')).toMatch(/class="katex/);
  });

  it('renders inline backslash-paren math', () => {
    expect(renderMarkdown('the limit \\(\\lim_{h\\to0} f\\) holds')).toMatch(/class="katex/);
  });

  it('renders block backslash-bracket math', () => {
    expect(renderMarkdown('\\[ x = \\frac{-b}{2a} \\]')).toMatch(/class="katex/);
  });

  it('leaves literal dollar signs in prose as text, not math', () => {
    const html = renderMarkdown('It costs $5 and $10 total.');
    expect(html).not.toMatch(/class="katex/);
    expect(html).toContain('$5');
    expect(html).toContain('$10');
  });
});

describe('R6 floor: a bad formula degrades to its source, never throws', () => {
  it('renders an invalid formula without throwing', () => {
    let html = '';
    expect(() => {
      html = renderMarkdown('before $\\notARealCommand$ after');
    }).not.toThrow();
    // KaTeX (throwOnError:false) shows the raw source in an error node...
    expect(html).toContain('notARealCommand');
    // ...and the rest of the document still renders.
    expect(html).toContain('after');
  });
});

describe('fenced-code highlighting (R3)', () => {
  it('highlights a known language', () => {
    const html = renderMarkdown('```python\ndef f():\n    return 1\n```');
    expect(html).toContain('class="language-python"');
    expect(html).toMatch(/hljs-/); // at least one highlighted token
  });

  it('falls back to plain escaped text for an unknown language (no throw)', () => {
    let html = '';
    expect(() => {
      html = renderMarkdown('```foolang-9000\n<not> & "real"\n```');
    }).not.toThrow();
    expect(html).toContain('class="hljs"');
    expect(html).toContain('&lt;not&gt;'); // escaped, not raw HTML
  });
});

describe('security: raw HTML is not passed through (§3/§7, html:false)', () => {
  it('escapes raw HTML in the source', () => {
    const html = renderMarkdown('<div onclick="x">hi</div>');
    expect(html).toContain('&lt;div');
    expect(html).not.toContain('<div');
  });
});

describe('source-line anchors for scroll sync (R18)', () => {
  it('annotates a heading and paragraph with their 0-based source line', () => {
    const html = renderMarkdown('# Title\n\nA paragraph.\n');
    expect(html).toMatch(/<h1[^>]*data-source-line="0"/);
    expect(html).toMatch(/<p[^>]*data-source-line="2"/);
  });

  it('annotates tables, lists, list items, and blockquotes at their start line', () => {
    const doc = [
      '# Heading', // 0
      '', // 1
      'A paragraph.', // 2
      '', // 3
      '- item one', // 4
      '- item two', // 5
      '', // 6
      '> a quote', // 7
      '', // 8
      '| A | B |', // 9
      '|---|---|', // 10
      '| 1 | 2 |', // 11
    ].join('\n');
    const html = renderMarkdown(doc);
    expect(html).toMatch(/<h1[^>]*data-source-line="0"/);
    expect(html).toMatch(/<p[^>]*data-source-line="2"/);
    expect(html).toMatch(/<ul[^>]*data-source-line="4"/);
    expect(html).toMatch(/<li[^>]*data-source-line="4"/);
    expect(html).toMatch(/<li[^>]*data-source-line="5"/);
    expect(html).toMatch(/<blockquote[^>]*data-source-line="7"/);
    expect(html).toMatch(/<table[^>]*data-source-line="9"/);
  });

  it('annotates nested blocks (e.g. a paragraph inside a blockquote)', () => {
    // The blockquote starts at line 0 and its inner paragraph also at line 0.
    const html = renderMarkdown('> quoted line one\n> quoted line two\n');
    expect(html).toMatch(/<blockquote[^>]*data-source-line="0"/);
    // the nested paragraph is annotated too (rule doesn't filter on nesting depth)
    expect(html).toMatch(/<p[^>]*data-source-line="0"/);
  });

  it('does not anchor fenced code blocks, but anchors their neighbours', () => {
    const doc = [
      'Intro paragraph.', // 0
      '', // 1
      '```js', // 2
      'const x = 1;', // 3
      '```', // 4
      '', // 5
      'After paragraph.', // 6
    ].join('\n');
    const html = renderMarkdown(doc);
    expect(html).toMatch(/<p[^>]*data-source-line="0"/);
    expect(html).toMatch(/<p[^>]*data-source-line="6"/);
    // The <pre> comes from the custom highlighter and carries no source line.
    expect(html).not.toMatch(/<pre[^>]*data-source-line/);
  });

  it('emits source lines 0-based and non-decreasing in document order', () => {
    const doc = [
      '# H', // 0
      '', // 1
      'para', // 2
      '', // 3
      '- a', // 4
      '- b', // 5
      '', // 6
      '> quote', // 7
      '', // 8
      '## H2', // 9
      '', // 10
      'last para', // 11
    ].join('\n');
    const html = renderMarkdown(doc);
    const lines = [...html.matchAll(/data-source-line="(\d+)"/g)].map((m) => Number(m[1]));
    expect(lines.length).toBeGreaterThan(5);
    expect(lines[0]).toBe(0); // first block starts at line 0
    expect(Math.max(...lines)).toBe(11); // last block at the last content line
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]).toBeGreaterThanOrEqual(lines[i - 1]);
    }
  });
});
