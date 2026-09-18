import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueDevTools from 'vite-plugin-vue-devtools';
import tailwindcss from '@tailwindcss/vite';

/* `vite build --ssr src/entry-server.ts` builds the prerender bundle; vitest merges this config, so it must stay a plain object. */
const isSsrBuild = process.argv.includes('--ssr');

// https://vite.dev/config/
export default defineConfig({
    clearScreen: false,
    server: {
        allowedHosts: true,
        port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
    },
    envPrefix: ['PUBLIC_'],
    /* The SSR bundle only renders the marketing pages for `scripts/prerender`; it needs neither devtools nor CSS. */
    plugins: isSsrBuild ? [vue()] : [vue(), vueDevTools(), tailwindcss()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    build: isSsrBuild
        ? {
              outDir: 'dist/server',
              emptyOutDir: true,
              rollupOptions: { output: { entryFileNames: 'entry-server.js' } },
          }
        : undefined,
});
