# Welcome to Galley

**Galley is a Markdown viewer and editor built to sit between you and your LLM tools.**
When an assistant hands you a `.md` file — notes, a plan, a spec, a draft — Galley shows it
the way it's meant to be read: headings, tables, math, and code rendered cleanly, with no
build step, no dev server, and nothing to configure. Open a file and read it; edit it and
watch the rendered view keep up as you type.

Think of it as a plain-text editor that also shows you what the file *actually looks like* —
the two side by side, always in sync.

## The basics

Galley opens a file in **reading view** — the rendered Markdown, full-window. Click
**Show Source** (top-right) to split the window and reveal the **source editor** on the right;
your edits update the rendered view live as you type. Hide it again to return to full-window
reading.

The two panes are anchored line for line, so jumping to a heading — or scrolling one pane —
brings the other along with it. You can read a long document on the left while keeping the
exact source in view on the right, without losing your place in either.

Open more files to get **tabs** — drag files onto the window, or launch Galley with them — and
switch between them with **Ctrl+Tab**. A link to another local Markdown file opens it as a new
tab; web links open in your system browser. Press **Ctrl/Cmd+F** while reading to search the
rendered page, jumping between matches with **Enter** / **Shift+Enter**.

This document is a scratch pad — nothing here is saved, so experiment freely. Opening a real
file replaces this screen.

## Try it out

You're looking at the rendered view. Give the editor a spin:

1. Click **Show Source**, then type — the view updates live.
2. Select a word and press **Ctrl/Cmd+B** for **bold** or **Ctrl/Cmd+I** for _italic_.
3. Press **Ctrl/Cmd+K** to insert a [link](https://commonmark.org/) from a small dialog.
4. Turn a line into a heading with **Ctrl/Cmd+1** through **Ctrl/Cmd+6**.
5. Drag the divider in the middle to resize the two panes.

## What Galley renders

Galley renders **GitHub Flavored Markdown**, **LaTeX math**, and **syntax-highlighted code**.

### Text styles

**bold**, _italic_, ~~strikethrough~~, and `inline code`. Links open in your system browser:
[the CommonMark spec](https://spec.commonmark.org/).

> Blockquotes render too — handy for quoting a passage or calling something out.

### Nested lists

Press **Tab** on a list line to nest it:

- Groceries
  - Fruit
    - Apples
    - Pears
  - Bread

### Task lists

- [x] Reply to the release thread
- [x] Merge the docs PR
- [ ] Write next week's plan
- [ ] Book the team offsite

### Tables

| Shortcut             | What it does           |
|----------------------|------------------------|
| `Ctrl/Cmd+B` / `+I`  | Bold / italic          |
| `Ctrl/Cmd+K`         | Insert or edit a link  |
| `Ctrl/Cmd+1`–`6`     | Heading level 1–6      |
| `Ctrl/Cmd+F`         | Find in the page       |
| `Ctrl+Tab`           | Next tab               |

### Math

Inline and block. The area of a circle is $A = \pi r^2$, and Euler's identity is
$e^{i\pi} + 1 = 0$. Bracket delimiters work as well: \(\sum_{i=1}^{n} i = \frac{n(n+1)}{2}\).

$$
\int_{0}^{1} x^2 \, dx = \frac{1}{3}
$$

## Code

Highlighted by language:

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

When you're ready, open one of your own files and Galley will pick up right where this left off.
