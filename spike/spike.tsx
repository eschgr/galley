/**
 * R5 rendering spike harness (standalone, not part of the shipped app).
 *
 * Renders the corpus through the real preview pipeline as a living fidelity
 * check. The spike originally compared two math engines; that comparison is
 * settled (texmath), so it now simply renders with the production pipeline.
 */
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import './spike.css';
import { createRoot } from 'react-dom/client';
import { renderMarkdown } from '../src/renderer/markdown/pipeline';
import { corpus } from '../src/renderer/markdown/corpus';

function Spike() {
  return (
    <div className="spike">
      <header className="spike-header">
        <h1>Galley — rendering fidelity check</h1>
        <p>markdown-it + markdown-it-texmath (KaTeX) + highlight.js</p>
      </header>
      {corpus.map((doc) => (
        <section className="spike-doc" key={doc.id} id={doc.id}>
          <div className="spike-doc-label">{doc.title}</div>
          <div
            className="markdown-preview"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.source) }}
          />
        </section>
      ))}
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root missing');
createRoot(container).render(<Spike />);
