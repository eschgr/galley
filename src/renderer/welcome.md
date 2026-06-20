# Welcome to Galley

A sandbox for trying the editor and seeing how Galley renders Markdown. Nothing
here is saved — experiment freely. Opening a file replaces this screen.

You're looking at the **rendered view**. Click **Show Source** (top-right) to
open the Markdown editor alongside it: edits update the view as you type, and
scrolling one pane keeps the other aligned.

## Things to try

1. Click **Show Source**, then type in the editor and watch this update live.
2. Select a word and press **Ctrl/Cmd+B** for **bold**, **Ctrl/Cmd+I** for _italic_.
3. Press **Ctrl/Cmd+K** to add a [link](https://commonmark.org/) from a little dialog.
4. Press **Ctrl/Cmd+1** through **6** to turn a line into a heading.
5. Drag the divider in the middle to resize the panes.
6. Press **Ctrl/Cmd+F** in the editor to search.

## What it renders

GitHub Flavored Markdown, LaTeX math, and syntax-highlighted code.

- **Bold**, _italic_, ~~strikethrough~~, `inline code`
- Links open in your browser: [the CommonMark spec](https://spec.commonmark.org/)
- Nested lists — press **Tab** on a list line to nest it:
  - second level
    - third level

### Task list

- [x] Render Markdown
- [x] Live preview
- [x] Formatting shortcuts
- [ ] Tabs

### A table

| Feature        | Status | Notes                       |
|----------------|--------|-----------------------------|
| Split view     | done   | resizable divider           |
| Live preview   | done   | updates as you type         |
| Scroll sync    | done   | anchored by source line     |
| Find / replace | done   | `Ctrl/Cmd+F` in the editor  |

### Math

Inline: the area of a circle is $A = \pi r^2$, and Euler's identity is
$e^{i\pi} + 1 = 0$. Backslash style works too: \(\sum_{i=1}^{n} i = \frac{n(n+1)}{2}\).

Block:

$$
\int_{0}^{1} x^2 \, dx = \frac{1}{3}
$$

### Code

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

## A little more, so there's something to scroll

Because the two panes are anchored by source line, jumping to a heading on one
side lands you near the same place on the other.

### Section A

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Praesent commodo cursus
magna, vel scelerisque nisl consectetur et. Donec id elit non mi porta gravida.

### Section B

Vestibulum id ligula porta felis euismod semper. Cras mattis consectetur purus
sit amet fermentum. Maecenas faucibus mollis interdum.

### The end

Scroll back up — the other pane should have followed you all the way down.
