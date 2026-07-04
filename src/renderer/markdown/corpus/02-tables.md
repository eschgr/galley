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

## Narrow first column, wide last column (#59)

A calendar: a short **Date** column beside a long **Notes** column. The dates must
stay on one line — the table should scroll rather than wrap "Tue Sep 1" across rows.

| Date      | Notes                                                                                       |
|-----------|---------------------------------------------------------------------------------------------|
| Mon Sep 1 | Kickoff at 6:30 PM in the main hall; bring the signed permission slips and a refillable water bottle. |
| Tue Sep 2 | Field trip to the observatory — buses leave promptly at 8:00 AM, and lunch will not be provided. |
| Wed Sep 3 | Guest speaker on deep-sea ecosystems, followed by a hands-on session with the touch-tank exhibits. |
