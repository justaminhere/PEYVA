import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = Number(process.env.PEYVA_WEB_PORT ?? 4317);
const dev = Number(process.env.PEYVA_WEB_DEV_PORT ?? 5173);

// Development only. The dev server and its proxy listen on 127.0.0.1; nothing is exposed to the network.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1", port: dev, strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${api}`, changeOrigin: false } },
  },
  preview: { host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
});
