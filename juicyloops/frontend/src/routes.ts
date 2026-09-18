import type { RouteRecordRaw } from 'vue-router';

const DESCRIPTION =
    'Make a beat in your browser in under a minute. Tap a step grid, play synths, samples and your own voice, then arrange, mix and automate a full track. Free, no signup, nothing to install.';

/**
 * The marketing pages (`/`, `/imprint`) are prerendered to static HTML at build time and hydrated
 * in the browser; the studio under `/app` is client only. `meta.title` and `meta.description`
 * feed the document head on both sides. `meta.module` names the record's source file so the
 * prerenderer can look its chunks up in the build manifest and preload them.
 */
const routes: Array<RouteRecordRaw> = [
    {
        path: '/',
        component: () => import('@/layouts/MarketingLayout.vue'),
        meta: { module: 'src/layouts/MarketingLayout.vue' },
        children: [
            {
                path: '',
                name: 'home',
                component: () => import('@/pages/home.vue'),
                meta: { title: 'Juicy Loops - Make beats in your browser', description: DESCRIPTION, prerender: true, module: 'src/pages/home.vue' },
            },
            {
                path: 'imprint',
                name: 'imprint',
                component: () => import('@/pages/imprint.vue'),
                meta: {
                    title: 'Imprint - Juicy Loops',
                    description: 'Legal notice and contact for Juicy Loops.',
                    prerender: true,
                    module: 'src/pages/imprint.vue',
                },
            },
        ],
    },
    {
        path: '/app',
        component: () => import('@/layouts/MainLayout.vue'),
        meta: { title: 'Juicy Loops Studio', description: DESCRIPTION },
        children: [
            {
                path: '',
                name: 'app.index',
                component: () => import('@/pages/index.vue'),
            },
            {
                path: 'song',
                name: 'app.song',
                component: () => import('@/pages/song.vue'),
            },
        ],
    },
];

export default routes;
