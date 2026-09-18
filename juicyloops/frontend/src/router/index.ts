import type { App } from 'vue';
import { createMemoryHistory, createRouter, createWebHistory, type Router } from 'vue-router';
import applicationRoutes from '@/routes';

/** One router per app instance: the browser keeps the URL bar in sync, the prerenderer uses memory history. */
export const createAppRouter = (): Router =>
    createRouter({
        history: import.meta.env.SSR ? createMemoryHistory(import.meta.env.BASE_URL) : createWebHistory(import.meta.env.BASE_URL),
        routes: [...applicationRoutes],
        scrollBehavior(to, _from, saved) {
            if (saved) {
                return saved;
            }
            return to.hash ? { el: to.hash, behavior: 'smooth' } : { top: 0 };
        },
    });

export const router = (app: App): Router => {
    const instance = createAppRouter();
    app.use(instance);
    return instance;
};
