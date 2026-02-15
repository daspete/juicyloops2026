import type { App } from "vue";
import { createWebHistory, createRouter } from "vue-router";
import applicationRoutes from "@/routes";

const vueRouter = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes: [...applicationRoutes],
});

export const router = (app: App) => {
    app.use(vueRouter);
};
