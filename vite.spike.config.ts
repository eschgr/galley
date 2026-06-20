import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Standalone Vite app for the R5 rendering spike. Serves spike/index.html and
// renders the corpus through the real src/ pipeline. Not part of the Electron
// build — run with `npm run spike`.
//
// Paths are resolved from this config file's own location (not process.cwd()),
// so it works regardless of the directory the spike is launched from.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(projectRoot, 'spike'),
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // Allow importing the pipeline/corpus from ../src and theme CSS from
    // ../node_modules (outside the spike root).
    fs: { allow: [projectRoot] },
  },
});
