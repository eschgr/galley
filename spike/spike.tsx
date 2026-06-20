/**
 * R5 rendering spike harness (standalone, not part of the shipped app).
 *
 * Renders the corpus through the candidate pipeline so fidelity can be visually
 * confirmed. The math engine is selectable via `?math=vscode-katex` or
 * `?math=texmath` (default) to compare the R6 ladder rungs side by side across
 * runs. The pipeline and corpus it imports ARE the real modules from src/.
 */
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import './spike.css';
import { createRoot } from 'react-dom/client';
import { renderMarkdown, type MathEngine, DEFAULT_MATH_ENGINE } from '../src/renderer/markdown/pipeline';
import { corpus } from '../src/renderer/markdown/corpus';

function currentEngine(): MathEngine {
  const q = new URLSearchParams(window.location.search).get('math');
  return q === 'vscode-katex' || q === 'texmath' ? q : DEFAULT_MATH_ENGINE;
}

function Spike() {
  const engine = currentEngine();
  const other: MathEngine = engine === 'texmath' ? 'vscode-katex' : 'texmath';
  return (
    <div className="spike">
      <header className="spike-header">
        <h1>mdtool — R5 rendering spike</h1>
        <p>
          math engine: <strong>{engine}</strong>
          {engine === 'vscode-katex' && (
            <span className="warn"> — dollar delimiters only; \( \) and \[ \] will show as raw text</span>
          )}
          {' · '}
          <a href={`?math=${other}`}>switch to {other}</a>
        </p>
      </header>
      {corpus.map((doc) => (
        <section className="spike-doc" key={doc.id} id={doc.id}>
          <div className="spike-doc-label">{doc.title}</div>
          <div
            className="markdown-preview"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.source, engine) }}
          />
        </section>
      ))}
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root missing');
createRoot(container).render(<Spike />);
