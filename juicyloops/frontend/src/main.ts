import '@/assets/css/main.css';
import { createApp } from 'vue';
import { router } from '@/router';
import { theme } from '@/theme';
import App from './app.vue';
import { createPlausible } from 'v-plausible/vue';

const app = createApp(App);

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

router(app);
theme(app);

app.use(plausible);

app.mount('#app');

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
            console.warn('Service worker registration failed:', error);
        });
    });
}
