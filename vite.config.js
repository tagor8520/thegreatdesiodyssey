import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fixtureProvider, pruneFixtureTiles } from './tools/fixture-provider/vite-plugin.mjs';

export default defineConfig({
  // Dev-only by construction: the fixture provider declares `apply: 'serve'`,
  // so it never participates in `vite build` and ships nothing to production.
  plugins: [fixtureProvider(), pruneFixtureTiles()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        classic: resolve(__dirname, 'classic.html'),
        reference: resolve(__dirname, 'reference.html'),
        vision: resolve(__dirname, 'vision.html'),
        contribution: resolve(__dirname, 'contribution.html'),
        tnc: resolve(__dirname, 'tnc.html')
      }
    }
  }
});
