import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
import { manifest } from './manifest';

export default defineConfig({
  srcDir: '.',
  modules: ['@wxt-dev/module-react'],
  manifest: { ...manifest, version: '0.1.0' },
  vite: () => ({ plugins: [tailwindcss()] }),
});
