import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'fs';

// 自定义插件：复制静态文件到dist
function copyManifestPlugin() {
  return {
    name: 'copy-manifest',
    closeBundle() {
      const distDir = resolve(__dirname, 'dist');
      const assetsDir = resolve(distDir, 'assets');
      const popupDir = resolve(distDir, 'popup');

      // 确保目录存在
      if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
      if (!existsSync(popupDir)) mkdirSync(popupDir, { recursive: true });

      // 复制manifest.json
      copyFileSync(
        resolve(__dirname, 'manifest.json'),
        resolve(distDir, 'manifest.json')
      );

      // 复制popup HTML
      copyFileSync(
        resolve(__dirname, 'src/popup/index.html'),
        resolve(popupDir, 'index.html')
      );

      // 复制popup CSS
      copyFileSync(
        resolve(__dirname, 'src/popup/styles.css'),
        resolve(popupDir, 'styles.css')
      );

      // 复制content CSS
      copyFileSync(
        resolve(__dirname, 'src/content/styles.css'),
        resolve(assetsDir, 'content.css')
      );

      // 复制SVG图标
      copyFileSync(
        resolve(__dirname, 'src/assets/icon.svg'),
        resolve(assetsDir, 'icon.svg')
      );

      console.log('✓ Static files copied to dist');
    }
  };
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        'popup/index': resolve(__dirname, 'src/popup/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
        format: 'es',
      },
    },
    target: 'esnext',
    minify: false,
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  plugins: [copyManifestPlugin()],
});
