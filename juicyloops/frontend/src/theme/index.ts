import { type App } from 'vue';

import PrimeVue from 'primevue/config';

import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';

import Aura from '@primeuix/themes/aura';
import { definePreset } from '@primeuix/themes';

import { FocusTrap, Ripple, Tooltip } from 'primevue';

/** Ink-violet surfaces so the coloured steps sit on a stage, not a spreadsheet. Matches --jl-* in globals.css. */
const SURFACE = {
    0: '#ffffff',
    50: '#f8f6fe',
    100: '#ebe8f7',
    200: '#dcd8ee',
    300: '#b8b1d9',
    400: '#8b84b0',
    500: '#6c668f',
    600: '#453d6e',
    700: '#2c2749',
    800: '#1f1b36',
    900: '#151229',
    950: '#0c0a17',
};

const JuicyTheme = definePreset(Aura, {
    semantic: {
        primary: {
            50: '#f5f3ff',
            100: '#ede9fe',
            200: '#ddd6fe',
            300: '#c4b5fd',
            400: '#a78bfa',
            500: '#8b5cf6',
            600: '#7c3aed',
            700: '#6d28d9',
            800: '#5b21b6',
            900: '#4c1d95',
            950: '#2e1065',
        },
        colorScheme: {
            dark: {
                surface: SURFACE,
                primary: {
                    color: '{primary.500}',
                    contrastColor: '#14092b',
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
