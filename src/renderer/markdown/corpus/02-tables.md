# Tables (GFM)

A plain table with header and rows:

| Language   | Typing   | First released |
|------------|----------|----------------|
| Python     | Dynamic  | 1991           |
| TypeScript | Static   | 2012           |
| Rust       | Static   | 2010           |

## Column alignment

Left, center, and right alignment via the colon syntax:

| Item            | Qty | Unit price | Subtotal |
|:----------------|:---:|-----------:|---------:|
| Widget          |   3 |      $4.00 |   $12.00 |
| Deluxe widget   |  10 |     $12.50 |  $125.00 |
| Shipping        |   1 |      $6.99 |    $6.99 |
| **Total**       |     |            | **$143.99** |

## Cells with inline formatting

Tables frequently carry `inline code`, **bold**, _italic_, links, and math:

| Symbol | Meaning                | Formula                |
|--------|------------------------|------------------------|
| `O(1)` | Constant time          | $T(n) = c$             |
| `O(n)` | Linear time            | $T(n) = c \cdot n$     |
| `μ`    | Population mean        | $\mu = \frac{1}{N}\sum x_i$ |
| ~~old~~ | Deprecated, see [docs](https://example.com/docs) | — |
