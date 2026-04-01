import { defineConfig } from 'vite';
import path from 'path';

// Project root is the parent of frontend/
const projectRoot = path.resolve(__dirname, '..');

export default defineConfig({
  root: '.',
  // Serve static files from the actual project root (so /models/, /assets/ resolve)
  publicDir: projectRoot,
  server: {
    port: 8088,
    // Allow serving files from the parent directory
    fs: {
      allow: [projectRoot],
    },
  },
  build: {
    outDir: path.resolve(projectRoot, 'dist'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
