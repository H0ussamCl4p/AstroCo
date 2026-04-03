import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';

// Project root is the parent of frontend/
const projectRoot = path.resolve(__dirname, '..');

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFileSync(src, dst) {
  ensureDirSync(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function copyDirSync(srcDir, dstDir) {
  ensureDirSync(dstDir);
  fs.cpSync(srcDir, dstDir, { recursive: true, force: true });
}

function copyRuntimeAssetsPlugin({ outDir }) {
  return {
    name: 'copy-runtime-assets',
    apply: 'build',
    closeBundle() {
      const resolvedOutDir = path.resolve(outDir);

      // Copy VRM model
      const vrmSrc = path.resolve(projectRoot, 'models', 'space-avatar.vrm');
      const vrmDst = path.resolve(resolvedOutDir, 'models', 'space-avatar.vrm');
      if (fs.existsSync(vrmSrc)) {
        copyFileSync(vrmSrc, vrmDst);
      } else {
        console.warn(`[copy-runtime-assets] Missing VRM: ${vrmSrc}`);
      }

      // Copy hologram GLTF scenes + textures
      const assetsOutDir = path.resolve(resolvedOutDir, 'assets');
      const hologramDirs = ['solar_system_animation', 'gateway_core', 'yutu'];
      for (const dirName of hologramDirs) {
        const srcDir = path.resolve(projectRoot, 'assets', dirName);
        const dstDir = path.resolve(assetsOutDir, dirName);
        if (fs.existsSync(srcDir)) {
          copyDirSync(srcDir, dstDir);
        } else {
          console.warn(`[copy-runtime-assets] Missing assets dir: ${srcDir}`);
        }
      }
    },
  };
}

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
      // IMPORTANT: our app uses /assets/... for large 3D scenes.
      // Put Vite's own hashed JS/CSS under /static/ to avoid collisions.
      assetsDir: 'static',
    },
    plugins: [copyRuntimeAssetsPlugin({ outDir: path.resolve(projectRoot, 'dist') })],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
  };
});
