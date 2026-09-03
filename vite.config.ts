import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'site',
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'core'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'site/index.html'),
        onePager: resolve(__dirname, 'site/one-pager.html'),
      },
    },
  },
});
