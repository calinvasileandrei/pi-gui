import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = `http://127.0.0.1:${process.env.PI_GUI_PORT ?? 4517}`;
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PI_GUI_VITE_PORT ?? 5173),
    strictPort: true,
    // changeOrigin rewrites Host (server requires a loopback Host); Origin stays 5173, allowed in dev mode.
    proxy: { "/ws": { target: server, ws: true, changeOrigin: true }, "/api": { target: server, changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
