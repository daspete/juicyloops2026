import '@/assets/css/main.css';
import { createJuicyApp } from '@/createApp';

const container = document.getElementById('app')!;
/* Prerendered pages carry their markup already; in dev, and for the studio shell, the container is empty. */
const hasMarkup = container.firstElementChild !== null;

const { app, router } = createJuicyApp(hasMarkup);

/*
 * PrimeVue, its theme preset and the services are only needed by the studio. They are pulled in the
 * first time an /app route resolves, so the marketing pages hydrate with the router and Vue alone.
 */
let studioReady: Promise<void> | undefined;
router.beforeEach((to) => {
    if (!to.path.startsWith('/app')) {
        return;
    }
    studioReady ??= import('@/theme').then(({ theme }) => theme(app));
    return studioReady;
});

/* Analytics after the page is interactive: it never competes with the first paint or hydration. */
const installAnalytics = async () => {
    const { createPlausible } = await import('v-plausible/vue');
    app.use(
        createPlausible({
            init: {
                domain: 'juicyloops.daspete.at',
                apiHost: 'https://analytics.dev.alpenstudios.com',
                trackLocalhost: true,
            },
            settings: {
                enableAutoPageviews: true,
                enableAutoOutboundTracking: true,
            },
        }),
    );
};

/* Wait for the route so hydration sees the same tree the prerenderer produced. */
router.isReady().then(() => {
    /* A host that falls back to /index.html for an unknown route hands us the home page's markup: drop it. */
    if (hasMarkup && router.currentRoute.value.meta.prerender !== true) {
        container.replaceChildren();
    }
    app.mount(container);

    const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 1));
    idle(() => void installAnalytics());
});
