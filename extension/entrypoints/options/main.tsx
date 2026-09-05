import { createRoot } from 'react-dom/client';

/** Settings are M2-14, which also carries the A-17 server change. */
const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(<main className="p-6 font-sans text-sm">CypherKey settings</main>);
}
