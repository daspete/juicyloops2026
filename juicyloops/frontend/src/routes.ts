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

        ],
    },
];

export default routes;
