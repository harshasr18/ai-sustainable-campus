import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite configuration for the web client.
 *
 * THE PROXY IS THE IMPORTANT PART. The browser must never be told where the API lives:
 * all client code calls relative paths (`/v1/...`), and this dev server forwards them to
 * the API process. Three reasons, in order of importance:
 *
 *   1. It works unchanged in every environment — localhost, a LAN IP, a deployed host, or
 *      a sandboxed preview proxied under someone else's domain. A hardcoded
 *      `http://localhost:3001` in client code breaks the moment the page is not opened on
 *      the same machine as the server.
 *   2. It keeps the API same-origin, so cookies and auth headers behave predictably and
 *      no CORS configuration is needed — which also means CORS is never loosened "to make
 *      the demo work".
 *   3. `npm run dev` remains a single command.
 *
 * `allowedHosts: true` is required because the dev server is reached through a proxied
 * preview domain, not `localhost`. Vite rejects unknown Host headers by default.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The preview is served from a platform-assigned hostname, so the Host header is not
    // localhost. This is a development-server setting only; `vite build` output is static
    // files with no host check.
    allowedHosts: true,
    proxy: {
      '/v1': {
        target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: false,
        // Photograph downloads stream through the same rule, so private evidence is
        // fetched from the API (with the caller's session) and never from a static dir.
      },
      '/healthz': {
        target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  optimizeDeps: {
    // `@campus/contracts` is workspace source (TypeScript), not a built dependency, so it
    // must be transformed by Vite rather than pre-bundled by esbuild as a CJS package.
    exclude: ['@campus/contracts'],
  },
});
