import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': {
        target: process.env.FACTORIX_BACKEND_TARGET || 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: process.env.FACTORIX_WS_TARGET || 'ws://127.0.0.1:8080',
        ws: true,
      },
    },
  },
});
