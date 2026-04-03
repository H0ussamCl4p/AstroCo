import { defineConfig } from 'vite';
import path from 'path';

// Project root is the parent of frontend/
const projectRoot = path.resolve(__dirname, '..');

export default defineConfig(({ command }) => {
  const isBuild = command === 'build';

  return {
    root: '.',
    // Don't copy/serve the whole project root during build
    // (In production, Nginx serves /assets/ and /models/ from the host folder)
    publicDir: isBuild ? false : projectRoot,
    server: {
      port: 8088,
      fs: {
        allow: [projectRoot],
      },
    },
    build: {
      outDir: path.resolve(projectRoot, 'dist'),
      emptyOutDir: true,
      copyPublicDir: false,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
  };
});
