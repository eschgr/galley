# Task lists

Claude often returns checklists. Mixed checked/unchecked, with nesting and
inline formatting inside items.

- [x] Initialize the repository and push to GitHub
- [x] Scaffold the Electron + React + TypeScript skeleton
- [ ] Run the **rendering spike** (this document)
- [ ] Build the editor + preview split view
- [ ] Wire the per-project channel listener

## Nested task list

- [ ] Rendering pipeline
  - [x] GFM tables and strikethrough
  - [x] Fenced-code highlighting
  - [ ] Math: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`
    - [x] dollar delimiters
    - [ ] backslash delimiters
- [ ] Conflict handling
  - [ ] Write-path guard
  - [ ] Read-path guard

## Mixed with an ordered list

1. First, read the PRD
2. Then validate rendering
   - [x] math
   - [ ] tables
3. Then build UI
