import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {VitePWA} from 'vite-plugin-pwa';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'icon.svg'],
        manifest: {
          id: '/',
          name: 'Счётчик упражнений',
          short_name: 'Счётчик',
          description: 'Приседания и движения ладоней с помощью камеры вашего Android устройства.',
          theme_color: '#f6f7f2',
          background_color: '#f6f7f2',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          categories: ['fitness', 'health', 'sports'],
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 35 * 1024 * 1024,
          globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm}'],
        },
        devOptions: {
          enabled: true,
        },
      }),
      {
        name: 'asset-cache-headers',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url && (req.url.includes('/assets/wasm/') || req.url.includes('/assets/models/'))) {
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            }
            next();
          });
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
