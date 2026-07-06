# Welcome to Galley

**Galley is a Markdown viewer and editor built to sit between you and your LLM tools.**
When an assistant hands you a `.md` file — notes, a plan, a spec, a draft — Galley shows it
the way it's meant to be read: headings, tables, math, and code rendered cleanly, with no
build step, no dev server, and nothing to configure. Open a file and read it; edit it and
watch the rendered view keep up as you type.

Think of it as a plain-text editor that also shows you what the file *actually looks like* —
the two side by side, always in sync.

## Try it out

This is a scratch document — nothing here is saved, so experiment freely. Opening a real file
replaces this screen.

You're looking at the **rendered view**. Here's the quick tour:

1. Click **Show Source** (top-right) to open the editor beside the preview, then type — the
   view updates live.
2. Select a word and press **Ctrl/Cmd+B** for **bold** or **Ctrl/Cmd+I** for _italic_.
3. Press **Ctrl/Cmd+K** to insert a [link](https://commonmark.org/) from a small dialog.
4. Turn a line into a heading with **Ctrl/Cmd+1** through **Ctrl/Cmd+6**.
5. Drag the divider in the middle to resize the two panes.
6. Press **Ctrl/Cmd+F** while reading to **search the rendered page** — every match
   highlights, and **Enter** / **Shift+Enter** jump between them. (In the source editor the
   same key opens find & replace.)
7. Open more files to get **tabs** — drag files onto the window, or launch Galley with them —
   and switch between them with **Ctrl+Tab**.

## What Galley renders

Galley renders **GitHub Flavored Markdown**, **LaTeX math**, and **syntax-highlighted code**.

**Text styles** — **bold**, _italic_, ~~strikethrough~~, and `inline code`. Links open in your
system browser: [the CommonMark spec](https://spec.commonmark.org/). A link to another local
Markdown file opens it as a new tab.

> Blockquotes render too — handy for quoting a passage or calling something out.

**Nested lists** — press **Tab** on a list line to nest it:

- Groceries
  - Fruit
    - Apples
    - Pears
  - Bread

**Task lists:**

- [x] Skim the document
- [x] Fix a typo in the source
- [ ] Send it back with notes

**Tables:**

| Shortcut             | What it does           |
|----------------------|------------------------|
| `Ctrl/Cmd+B` / `+I`  | Bold / italic          |
| `Ctrl/Cmd+K`         | Insert or edit a link  |
| `Ctrl/Cmd+1`–`6`     | Heading level 1–6      |
| `Ctrl/Cmd+F`         | Find in the page       |
| `Ctrl+Tab`           | Next tab               |

**Math**, inline and block. The area of a circle is $A = \pi r^2$, and Euler's identity is
$e^{i\pi} + 1 = 0$. Bracket delimiters work as well: \(\sum_{i=1}^{n} i = \frac{n(n+1)}{2}\).

$$
\int_{0}^{1} x^2 \, dx = \frac{1}{3}
$$

**Code**, highlighted by language:

```typescript
function greet(name: string): string {
  return `Hello, ${name}!`;
}

console.log(greet('Galley'));
```

```python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

---

## Reading long documents

The preview and the source editor are anchored line for line, so jumping to a heading — or
scrolling one pane — brings the other along with it. You can read a long document on the left
while keeping the exact source in view on the right, without losing your place in either.

When you're ready, open one of your own files and Galley will pick up right where this left
off.
