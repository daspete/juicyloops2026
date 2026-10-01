import '@/assets/css/main.css';
import { createJuicyApp } from '@/createApp';
import type { TrackEvent } from './analytics/outboundLinks';

const container = document.getElementById('app')!;
/* Prerendered pages carry their markup already; in dev, and for the studio shell, the container is empty. */
const hasMarkup = container.firstElementChild !== null;

const { app, router } = createJuicyApp(hasMarkup);

/*
 * PrimeVue, its theme preset and the services are only needed by the studio. They are pulled in the
 * first time an /app route resolves, so the marketing pages hydrate with the router and Vue alone.
 */
let studioReady: Promise<void> | undefined;
router.beforeEach((to, from) => {
    if (!to.path.startsWith('/app')) {
        return;
    }
    studioReady ??= import('@/theme').then(({ theme }) => theme(app));
    /*
     * A client side entry from a marketing page gets the studio splash too (a full load of /app has it inline in the
     * shell). It is appended before the navigation resolves, so the studio never renders ahead of it; it shows once
     * per tab and a failed load never blocks the studio.
     */
    const entering = from.matched.length > 0 && !from.path.startsWith('/app');
    const splash = entering
        ? import('@/splash/playSplash').then(({ playSplash }) => playSplash()).catch(() => undefined)
        : undefined;
    return Promise.all([studioReady, splash]).then(() => undefined);
});

/* Analytics after the page is interactive: it never competes with the first paint or hydration. */
const installAnalytics = async () => {
    const [{ createPlausible }, { trackOutboundLinks }] = await Promise.all([import('v-plausible/vue'), import('./analytics/outboundLinks')]);
    app.use(
        createPlausible({
            init: {
                domain: 'juicyloops.daspete.at',
                apiHost: 'https://analytics.dev.alpenstudios.com',
                trackLocalhost: true,
            },
            settings: {
                enableAutoPageviews: true,
                // Its own outbound tracking redirects every outside link in the same tab, `target="_blank"` or not.
                enableAutoOutboundTracking: false,
            },
        }),
    );
    const plausible = app.config.globalProperties.$plausible as { trackEvent: TrackEvent } | undefined;
    if (plausible) {
        trackOutboundLinks((name, options) => plausible.trackEvent(name, options));
    }
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
