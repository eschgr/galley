// Minimal ambient declarations for the markdown-it plugins that ship no types.
// Only the surface the pipeline uses is declared.

declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';
  interface TaskListsOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }
  const taskLists: (md: MarkdownIt, options?: TaskListsOptions) => void;
  export default taskLists;
}

declare module 'markdown-it-texmath' {
  import type MarkdownIt from 'markdown-it';
  interface TexmathOptions {
    engine: unknown; // the katex module
    delimiters?: string | string[];
    outerSpace?: boolean;
    katexOptions?: Record<string, unknown>;
    macros?: Record<string, string>;
  }
  const texmath: (md: MarkdownIt, options?: TexmathOptions) => void;
  export default texmath;
}
