// Vite raw imports (e.g. `import md from './doc.md?raw'`).
declare module '*?raw' {
  const content: string;
  export default content;
}
