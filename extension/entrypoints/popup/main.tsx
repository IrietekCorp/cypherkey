import { createRoot } from 'react-dom/client';
import { applyTheme } from '../../src/design/theme';
import { App } from './App';
import './style.css';

// Dark is the default the style guide specifies; light is the same tokens remapped.
// Stamped before the first render so no frame paints on the wrong ground.
applyTheme(document, window);

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<App />);
