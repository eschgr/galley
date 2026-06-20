import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './pipeline';

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
  it('annotates block elements with their 0-based source line', () => {
    const html = renderMarkdown('# Title\n\nA paragraph.\n');
    expect(html).toMatch(/<h1[^>]*data-source-line="0"/);
    expect(html).toMatch(/<p[^>]*data-source-line="2"/);
  });
});
