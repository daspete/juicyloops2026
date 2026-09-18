import { type App } from 'vue';

import PrimeVue from 'primevue/config';

import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';

import Aura from '@primeuix/themes/aura';
import { definePreset } from '@primeuix/themes';

import { FocusTrap, Ripple, Tooltip } from 'primevue';

/** Warm charcoal surfaces so the coloured steps sit on something that feels like a dark room, not a spreadsheet. */
const SURFACE = {
    0: '#ffffff',
    50: '#f8f5f1',
    100: '#efe9e3',
    200: '#ddd3ca',
    300: '#bdb0a5',
    400: '#8f8277',
    500: '#6b5f56',
    600: '#4c423b',
    700: '#332b26',
    800: '#241e1a',
    900: '#171310',
    950: '#0f0c0a',
};

const JuicyTheme = definePreset(Aura, {
    semantic: {
        primary: {
            50: '#fff1ed',
            100: '#fee6e0',
            200: '#fec8ba',
            300: '#fead95',
            400: '#fd9167',
            500: '#f97316',
            600: '#c65a0f',
            700: '#944108',
            800: '#652a04',
            900: '#3c1601',
            950: '#260b01',
        },
        colorScheme: {
            dark: {
                surface: SURFACE,
                primary: {
                    color: '{primary.500}',
                    contrastColor: '#1a0d04',
                    hoverColor: '{primary.400}',
                    activeColor: '{primary.600}',
                },
            },
        },
    },
    components: {},
});

export const theme = (app: App) => {
    app.use(PrimeVue, {
        ripple: true,
        theme: {
            preset: JuicyTheme,
            options: {
                darkModeSelector: '.dark',
                cssLayer: {
                    name: 'primevue',
                    order: 'theme, base, primevue',
                },
            },
        },
    });

    app.use(ConfirmationService);
    app.use(ToastService);

    app.directive('ripple', Ripple);
    app.directive('focustrap', FocusTrap);
    app.directive('tooltip', Tooltip);
};
