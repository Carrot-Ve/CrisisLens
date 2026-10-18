import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 显式指定 root，使 npm script 从包根目录运行时也能正确定位 web/ 下的源码与产物。
const here = dirname(fileURLToPath(import.meta.url));

// 开发态：Vite(5173) 代理 /api 到后端(8787)，避免 CORS 与双端口调试。
// 生产态：由后端直接托管 web/dist，同源，无代理。
export default defineConfig({
  root: here,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
