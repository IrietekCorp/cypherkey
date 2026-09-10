import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/*
  Tailwind is gone from the site.

  The redesign is a small number of design objects used many times -- a glass card, a
  kicker, a section rule -- rather than a utility vocabulary, and `styles.css` says so in
  one place. The extension still uses Tailwind; this only changes the marketing site,
  which was shipping a utility framework it used a fraction of.
*/
export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(import.meta.dirname, '../core'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        demo: resolve(import.meta.dirname, 'demo.html'),
        pricing: resolve(import.meta.dirname, 'pricing.html'),
        beta: resolve(import.meta.dirname, 'beta.html'),
        technology: resolve(import.meta.dirname, 'technology.html'),
        investors: resolve(import.meta.dirname, 'investors.html'),
        compare: resolve(import.meta.dirname, 'compare.html'),
        founder: resolve(import.meta.dirname, 'founder.html'),
        onePager: resolve(import.meta.dirname, 'one-pager.html'),
      },
      output: {
        /*
          Analytics stays its own chunk rather than being folded into a page's bundle.

          Two pages import nothing else, so Rollup would happily inline it into each of
          them — and then `demo.html`, which must not have it, is one careless import
          away from getting it through a shared chunk. A named entry makes its absence
          from the trial checkable rather than incidental.
        */
        manualChunks: (id: string) => (id.includes('analytics.ts') ? 'analytics' : undefined),
      },
    },
  },
});
