import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(__dirname, 'web'),
  plugins: [vue()],
  server: {
    port: 5198,
    proxy: {
      '/api': { target: 'http://localhost:5199', changeOrigin: true }
    }
  },
  build: {
    outDir: path.join(__dirname, 'web', 'dist'),
    emptyOutDir: true
  }
});
