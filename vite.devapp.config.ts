import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Renderer-only dev server: serves the REAL app entry (index.html →
// src/renderer.tsx → App) in a plain browser, so the renderer UI can be
// iterated and screenshotted without spinning up Electron. The main-process
// bridge (window.galley) is absent in the browser; the renderer guards for it.
// Run with `npm run devapp`.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: projectRoot,
  plugins: [react()],
  server: {
    port: 5181,
    strictPort: true,
    fs: { allow: [projectRoot] },
  },
});
