import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa';

export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'prompt',
  includeAssets: ['logo.svg', 'favicon.svg', 'icons/*.svg'],
  manifest: {
    name: '一事',
    short_name: '一事',
    description: '支持离线使用和多设备同步的专注学习工具',
    lang: 'zh-CN',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#f3f0e8',
    background_color: '#f3f0e8',
    icons: [
      { src: '/icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
      { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
      { src: '/icons/icon-maskable.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  },
  workbox: {
    cleanupOutdatedCaches: true,
    navigateFallback: 'index.html',
    navigateFallbackDenylist: [/^\/api(?:\/|$)/],
    globPatterns: ['**/*.{html,js,css,svg,png,webmanifest}'],
    runtimeCaching: [{
      urlPattern: /^\/api(?:\/|$)/,
      handler: 'NetworkOnly',
      method: 'GET',
    }],
  },
};

const apiProxy = process.env.KAOYAN_API_ORIGIN
  ? {
      '/api': {
        target: process.env.KAOYAN_API_ORIGIN,
        changeOrigin: true,
      },
    }
  : undefined;

export default defineConfig({
  base: '/',
  build: { target: 'esnext', emptyOutDir: true },
  plugins: [react(), VitePWA(pwaOptions)],
  ...(apiProxy ? { server: { proxy: apiProxy }, preview: { proxy: apiProxy } } : {}),
});
