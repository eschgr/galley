/**
 * Root component — skeleton only.
 *
 * This is a placeholder shell to prove the Electron + React + preload-bridge
 * wiring runs end to end (`npm start` opens a window showing this). No product
 * features (editor, preview, tabs, split view) are built yet; the first real
 * work is the R5 rendering spike.
 */
export function App() {
  return (
    <main className="app-skeleton">
      <h1>mdtool</h1>
      <p>Local markdown viewer &amp; editor — skeleton.</p>
      <p className="env">
        platform <code>{window.mdtool?.platform ?? 'unknown'}</code> · version{' '}
        <code>{window.mdtool?.version ?? '?'}</code>
      </p>
      <p className="next">Next build step: the R5 rendering spike (PRD §5.1a).</p>
    </main>
  );
}
