import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 8080,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: false },
      "/health": { target: "http://127.0.0.1:8000", changeOrigin: false },
      "/stream": { target: "ws://127.0.0.1:8000", ws: true, changeOrigin: false },
    },
  },
});
