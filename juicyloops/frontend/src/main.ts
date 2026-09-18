import '@/assets/css/main.css';
import { createJuicyApp } from '@/createApp';
import { theme } from '@/theme';
import { createPlausible } from 'v-plausible/vue';

const container = document.getElementById('app')!;
/* Prerendered pages carry their markup already; in dev, and for the studio shell, the container is empty. */
const hasMarkup = container.firstElementChild !== null;

const { app, router } = createJuicyApp(hasMarkup);

const plausible = createPlausible({
    init: {
        domain: 'juicyloops.daspete.at',
        apiHost: 'https://analytics.dev.alpenstudios.com',
        trackLocalhost: true,
    },
    settings: {
        enableAutoPageviews: true,
        enableAutoOutboundTracking: true,
    },
});

theme(app);

app.use(plausible);

/* Wait for the route so hydration sees the same tree the prerenderer produced. */
router.isReady().then(() => {
    /* A host that falls back to /index.html for an unknown route hands us the home page's markup: drop it. */
    if (hasMarkup && router.currentRoute.value.meta.prerender !== true) {
        container.replaceChildren();
    }
    app.mount(container);
});
