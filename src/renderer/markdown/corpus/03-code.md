# Fenced code with language highlighting

Inline code like `const x = 42` and `git rebase -i HEAD~3` should be styled but
not highlighted. Fenced blocks carry a language info string.

## Python

```python
from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float

    def distance(self, other: "Point") -> float:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5


pts = [Point(0, 0), Point(3, 4)]
print(f"distance = {pts[0].distance(pts[1])}")  # 5.0
```

## TypeScript

```typescript
interface User {
  id: number;
  name: string;
  roles: ReadonlyArray<"admin" | "editor" | "viewer">;
}

async function loadUser(id: number): Promise<User> {
  const res = await fetch(`/api/users/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as User;
}
```

## JSON

```json
{
  "name": "mdtool",
  "private": true,
  "scripts": { "start": "electron-forge start" },
  "dependencies": { "markdown-it": "^14.1.0", "katex": "^0.16.11" }
}
```

## Shell

```bash
#!/usr/bin/env bash
set -euo pipefail
for f in *.md; do
  echo "rendering ${f}"
  mdtool "$(realpath "$f")"
done
```

## SQL

```sql
SELECT u.name, COUNT(o.id) AS orders
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.active = TRUE
GROUP BY u.name
HAVING COUNT(o.id) > 5
ORDER BY orders DESC;
```

## Unknown / no language (highlight floor)

A made-up info string must not break rendering — it falls back to plain text:

```foolang-9000
:: this language does not exist ::
@compute (a, b) => a <~> b
```

```
plain fenced block, no language given
indented   columns   preserved
```
