import { ref, watch } from 'vue';

export type ThemeName = 'dark' | 'light';

const STORAGE_KEY = 'juicyloops:theme';

const readStored = (): ThemeName | null => {
    try {
        const value = localStorage.getItem(STORAGE_KEY);
        return value === 'dark' || value === 'light' ? value : null;
    } catch {
        return null;
    }
};

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

const systemTheme = (): ThemeName => (isBrowser && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

/* One theme for the whole app: `html.dark` drives both our tokens and PrimeVue's dark palette. */
const theme = ref<ThemeName>(readStored() ?? systemTheme());

const apply = (name: ThemeName) => {
    if (isBrowser) {
        document.documentElement.classList.toggle('dark', name === 'dark');
    }
};

apply(theme.value);

watch(theme, (name) => {
    apply(name);
    try {
        localStorage.setItem(STORAGE_KEY, name);
    } catch {
        /* private mode or blocked storage: the choice simply does not persist */
    }
});

const toggleTheme = () => (theme.value = theme.value === 'dark' ? 'light' : 'dark');

export const useTheme = () => ({ theme, toggleTheme });
