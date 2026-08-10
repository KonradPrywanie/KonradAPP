// `defineConfig` z 'vitest/config', nie z 'vite' — tylko ten wariant
// zna sekcję `test`.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'FITKonrad',
        short_name: 'FITKonrad',
        description: 'Trener i dietetyk w jednej aplikacji',
        lang: 'pl',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App-shell offline-first. Dane użytkownika żyją w IndexedDB,
        // więc SW cache'uje tylko statyki — nie ma tu nic do zsynchronizowania.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    // `.tsx` też — testy renderowania UI mieszkają obok komponentów.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
    // Testy renderowania czekają na łańcuch zapytań do IndexedDB; przy
    // 11 plikach biegnących równolegle domyślne 5 s bywa za mało.
    testTimeout: 20_000,
  },
})
