/**
 * The rendering-spike corpus: representative real Claude markdown output across the
 * four stress categories the PRD calls out (math-heavy, table-heavy, code-heavy,
 * task lists), plus a mixed "typical reply" document. Loaded as raw text and
 * rendered through the candidate pipeline so fidelity can be eyeballed.
 */
import math from './01-math.md?raw';
import tables from './02-tables.md?raw';
import code from './03-code.md?raw';
import tasks from './04-tasks.md?raw';
import mixed from './05-mixed.md?raw';

export interface CorpusDoc {
  id: string;
  title: string;
  source: string;
}

export const corpus: CorpusDoc[] = [
  { id: 'math', title: 'Math', source: math },
  { id: 'tables', title: 'Tables', source: tables },
  { id: 'code', title: 'Code', source: code },
  { id: 'tasks', title: 'Task lists', source: tasks },
  { id: 'mixed', title: 'Mixed', source: mixed },
];
