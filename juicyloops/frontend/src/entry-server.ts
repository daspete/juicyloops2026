import { renderToString } from 'vue/server-renderer';
import { createJuicyApp } from './createApp';
import routes from './routes';

export interface RenderedPage {
    html: string;
    title: string;
    description: string;
    /** Source files (manifest keys) of the layout and page the route renders; the prerenderer preloads their chunks. */
    modules: string[];
}

/** Renders one marketing route to HTML; the prerender script writes it into the built index.html. */
export const render = async (url: string): Promise<RenderedPage> => {
    const { app, router } = createJuicyApp();
    await router.push(url);
    await router.isReady();

    const route = router.currentRoute.value;
    const html = await renderToString(app);

    return {
        html,
        title: (route.meta.title as string | undefined) ?? 'Juicy Loops',
        description: (route.meta.description as string | undefined) ?? '',
        modules: route.matched.flatMap((record) => (typeof record.meta.module === 'string' ? [record.meta.module] : [])),
    };
};

/** Every route that is rendered at build time. */
export const prerenderPaths = (): string[] => {
    const paths: string[] = [];
    const walk = (records: typeof routes, base: string) => {
        for (const record of records) {
            const path = record.path.startsWith('/') ? record.path : `${base.replace(/\/$/, '')}/${record.path}`;
            if (record.meta?.prerender) {
                paths.push(path.replace(/\/$/, '') || '/');
            }
            if (record.children) {
                walk(record.children, path);
            }
        }
    };
    walk(routes, '');
    return paths;
};
