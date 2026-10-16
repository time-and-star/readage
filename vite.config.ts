import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import { VITE_WATCH_IGNORED } from './src/viteWatchConfig';

export default defineConfig(() => {
  const offline = process.env.VITE_OFFLINE_APP === 'true';
  const android = process.env.VITE_APP_PLATFORM === 'android';
  return {
    ...(android ? { build: {
      target: 'chrome91', cssTarget: 'chrome91', cssMinify: 'lightningcss' as const,
      // Layer priorities must be converted after the complete stylesheet has been bundled.
      cssCodeSplit: false,
    } } : {}),
    plugins: [react(), tailwindcss(), ...(offline ? [{
      name: 'readage-offline-policy',
      transformIndexHtml() {
        return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy',
          content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'" }, injectTo: 'head-prepend' as const }];
      },
    }] : [])],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // Always ignore simulation artifacts — agent tools rewrote them in a tight loop and
      // flooded Vite with full page reloads until the dev server died.
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : {
              ignored: [...VITE_WATCH_IGNORED],
            },
    },
  };
});
