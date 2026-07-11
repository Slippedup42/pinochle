/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Project-page hosting on GitHub Pages: https://slippedup42.github.io/pinochle/
// (no custom domain configured — see ROADMAP.md Phase 1.5). Vite needs the
// repo name as the base path so built asset URLs resolve correctly.
const base = '/pinochle/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: '/pinochle/',
        name: 'Pinochle',
        short_name: 'Pinochle',
        description: 'Partnership Pinochle — play against AI opponents.',
        start_url: '/pinochle/',
        scope: '/pinochle/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#14532d',
        background_color: '#14532d',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Offline shell caching: precache the built app shell so the game
        // loads (and can be reopened) without a network connection.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  test: {
    environment: 'jsdom',
  },
})
