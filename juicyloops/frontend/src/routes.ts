import type { RouteRecordRaw } from 'vue-router';

const routes: Array<RouteRecordRaw> = [
    {
        path: '',
        name: 'app',
        redirect: { name: 'app.index' },
        component: () => import('@/layouts/MainLayout.vue'),
        children: [
            {
                path: 'app',
                name: 'app.index',
                component: () => import('@/pages/index.vue'),
            },
            {
                path: 'app/song',
                name: 'app.song',
                component: () => import('@/pages/song.vue'),
            },
        ],
    },
];

export default routes;
