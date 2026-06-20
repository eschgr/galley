# Welcome to mdtool

You're looking at the **rendered view** — how a markdown file actually reads.

Use the **Split** / **View** switch in the top-right corner to choose your
layout:

- **View** — the rendered document only, for reading (this is the default).
- **Split** — the markdown **source editor on the left** and this live preview
  on the right, side by side. Edit the source and the preview updates as you
  type; scroll one pane and the other follows.

> File opening isn't wired up yet — this is a built-in sample so you can try the
> view modes, editor, and preview. Tabs, opening files, and saving come next.

## Try it

1. Click **Split** (top-right) to bring up the source editor beside this view.
2. Type in the left pane and watch the preview update live.
3. Drag the divider in the middle to resize the two panes.
4. Press `Ctrl+F` (or `Cmd+F`) in the editor to open the find panel.
5. Scroll either pane — they stay aligned by source line.
6. Click **View** to go back to full-window reading.

## Markdown it renders

GitHub Flavored Markdown plus LaTeX math, with syntax-highlighted code.

- **Bold**, _italic_, ~~strikethrough~~, `inline code`
- Links open in your browser: [the CommonMark spec](https://spec.commonmark.org/)
- Nested lists
  - second level
    - third level

### Task list

- [x] Render markdown
- [x] Live preview
- [ ] Open and save files
- [ ] Tabs

### A table

| Feature        | Status      | Notes                         |
|----------------|-------------|-------------------------------|
| Split view     | done        | resizable divider             |
| Live preview   | done        | updates as you type           |
| Scroll sync    | done        | anchored by source line       |
| Find / replace | done        | `Ctrl/Cmd+F` in the editor    |

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

console.log(greet('mdtool'));
```

```python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

---

## Some filler to make it scroll

Markdown keeps the source readable while the preview shows the formatted result.
Because the two panes are anchored by source line, jumping to a heading on one
side lands you near the same place on the other.

### Section A

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Praesent commodo cursus
magna, vel scelerisque nisl consectetur et. Donec id elit non mi porta gravida.

### Section B

Vestibulum id ligula porta felis euismod semper. Cras mattis consectetur purus
sit amet fermentum. Maecenas faucibus mollis interdum.

### Section C

Nullam quis risus eget urna mollis ornare vel eu leo. Cum sociis natoque
penatibus et magnis dis parturient montes, nascetur ridiculus mus.

### The end

Scroll back up — the other pane should have followed you all the way down.
