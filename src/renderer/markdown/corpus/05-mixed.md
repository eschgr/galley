# A representative Claude answer

This document mixes the elements that show up together in a typical reply, to
check they coexist without interfering.

## Background

Markdown is a lightweight markup language. The **CommonMark** spec standardized
it; _GitHub Flavored Markdown_ (GFM) adds tables, task lists, strikethrough
(~~like this~~), and autolinking. A bare URL such as https://commonmark.org
should become a link automatically.

> **Note:** mdtool renders a GFM + LaTeX-math flavor intended to match Claude's
> typical output. Raw HTML passthrough is intentionally disabled.

## Steps

1. Parse the source with `markdown-it`.
2. Apply plugins for GFM and math.
3. Highlight fenced code with `highlight.js`.
4. Hand the HTML to the preview pane.

Key terms:

- **Tokenization** — splitting source into a token stream.
- **Rendering** — turning tokens into HTML.
  - This can be *nested* arbitrarily deep.
  - Like this second level.

## A little of everything

The relationship is roughly linear, $y \approx \beta_0 + \beta_1 x$, with a
small table of coefficients:

| Coefficient | Estimate | Std. error |
|-------------|---------:|-----------:|
| $\beta_0$   |     1.04 |       0.21 |
| $\beta_1$   |     2.51 |       0.08 |

```python
import numpy as np
beta = np.polyfit(x, y, deg=1)   # [slope, intercept]
```

See the [project README](./README.md) for more, and visit
[the spec](https://spec.commonmark.org/) for the gory details.

---

That horizontal rule above, and this final paragraph, should both render cleanly.
