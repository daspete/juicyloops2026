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
        : {
              /* The prerenderer reads the manifest to preload each page's chunks; it deletes it afterwards. */
              manifest: true,
              rollupOptions: {
                  output: {
                      /* Big, rarely changing libraries get their own chunks so a change in the app does not bust their cache. */
                      advancedChunks: {
                          /* Group by the module's own path only; otherwise Vue would be dragged into the PrimeVue chunk. */
                          includeDependenciesRecursively: false,
                          groups: [
                              /* Tone stays with the engine code: pulled into its own chunk it ends up in a circular pair with it and fails at load. */
                              { name: 'vendor-wavesurfer', test: /node_modules[\\/]wavesurfer\.js[\\/]/ },
                              { name: 'vendor-primevue', test: /node_modules[\\/](primevue|@primeuix|@primevue)[\\/]/ },
                              { name: 'vendor-vue', test: /node_modules[\\/](@vue|vue|vue-router)[\\/]/ },
                          ],
                      },
                  },
              },
          },
});
