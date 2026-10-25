import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [],
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
        vision: resolve(__dirname, 'vision.html'),
        contribution: resolve(__dirname, 'contribution.html'),
        tnc: resolve(__dirname, 'tnc.html')
      }
    }
  }
});
