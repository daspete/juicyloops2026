import { type App } from 'vue';

import PrimeVue from 'primevue/config';

import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';

import Aura from '@primeuix/themes/aura';
import { definePreset } from '@primeuix/themes';

import { FocusTrap, Ripple } from 'primevue';

const ManabloxTheme = definePreset(Aura, {
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
    },
    components: {},
});

export const theme = (app: App) => {
    app.use(PrimeVue, {
        ripple: true,
        theme: {
            preset: ManabloxTheme,
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
};
