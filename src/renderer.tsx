/**
 * Renderer entry. Runs in the isolated browser context (no Node). Mounts the
 * React tree into #root. The only main-process surface available here is
 * `window.galley` (see src/preload.ts / src/shared/api.ts).
 */
import './shared/api'; // pulls in the global Window.galley type augmentation
import './index.css';
import { createRoot } from 'react-dom/client';
import { App } from './renderer/App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root not found in index.html');
}

createRoot(container).render(<App />);
