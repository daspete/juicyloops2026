import { createApp, createSSRApp, type App } from 'vue';
import type { Router } from 'vue-router';
import { router as installRouter } from '@/router';
import Root from './app.vue';

/**
 * The part of the app both sides share: the root component and the router.
 * The browser adds PrimeVue and analytics on top (see `main.ts`); the prerenderer renders this as is.
 * `hydrate` picks the SSR flavour, which expects prerendered markup in the container.
 */
export const createJuicyApp = (hydrate = true): { app: App; router: Router } => {
    const app = hydrate ? createSSRApp(Root) : createApp(Root);
    const router = installRouter(app);

    router.afterEach((to) => {
        if (typeof document === 'undefined') {
            return;
        }
        const title = to.matched
            .map((record) => record.meta.title)
            .filter((title): title is string => typeof title === 'string')
            .pop();
        if (title) {
            document.title = title;
        }
    });

    return { app, router };
};
