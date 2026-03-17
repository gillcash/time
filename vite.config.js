import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      injectRegister: false,
      includeAssets: ['icons/*.png', 'favicon.ico', 'favicon-*.png', 'apple-touch-icon*.png'],
      manifest: {
        name: 'Time',
        short_name: 'Time',
        description: 'GPS-verified clock-in/clock-out time tracking',
        start_url: '/',
        display: 'standalone',
        background_color: '#181A1D',
        theme_color: '#181A1D',
        orientation: 'portrait',
        icons: [
          {
            src: '/icons/android-chrome-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icons/android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icons/android-chrome-192x192-maskable.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: '/icons/android-chrome-512x512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        runtimeCaching: [
          {
            urlPattern: /\/api\/time\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-time',
              networkTimeoutSeconds: 10,
              plugins: [
                {
                  cacheWillUpdate: async ({ response }) => {
                    return response && response.status === 200 ? response : null;
                  }
                }
              ]
            }
          }
        ]
      }
    })
  ],
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false
  },
  server: {
    port: 3000,
    host: true
  }
});
