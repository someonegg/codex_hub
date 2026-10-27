import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "session-page-route",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
          if (
            pathname === "/artifacts" ||
            /^\/diffs\/[a-f0-9-]{36}$/.test(pathname) ||
            /^\/sessions\/[A-Za-z0-9_-]{20,100}(?:\/uploads)?\/?$/.test(pathname)
          ) {
            request.url = `/index.html${(request.url ?? "").slice(pathname.length)}`;
          }
          next();
        });
      },
    },
  ],
  appType: "mpa",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
