import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  // HMR is intentionally OFF (decided 2026-06-20). The user prefers restarting
  // the app to pick up code changes, so it's unambiguous when the *software*
  // changed versus when the open *file* changed (Ctrl+R reloads the file only —
  // see src/main/menu.ts). Without HMR, edits to renderer code don't hot-apply;
  // restart `npm start` to see them.
  server: { hmr: false },
});
