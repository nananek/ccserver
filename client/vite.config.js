import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    minify: 'terser',
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      // changeOrigin: false (the default, kept explicit here) -- CCSERVER_AUTH_MODE=passkey's
      // WebAuthn origin/rpID checks (server/webauthnChallenges.js) are derived from the
      // request's Host header. `true` here would rewrite that header to the proxy target
      // (localhost:3001), while the browser's real WebAuthn ceremony still reports
      // location.origin as localhost:5173 -- the two would never match, and every
      // registration/authentication would fail with "verification failed" whenever
      // CCSERVER_AUTH_MODE=passkey is tested under `npm run dev`. `/ws` never set this in
      // the first place; `/api` now matches it for the same reason.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: false,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
