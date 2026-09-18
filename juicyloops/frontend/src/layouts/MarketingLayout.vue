<script setup lang="ts">
/**
 * Shell of the public pages: header, page, footer. The studio (`/app`) has its own layout.
 * The shell scrolls itself because the app's body is `overflow: hidden` for the studio.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import JuicyLogo from '@/components/JuicyLogo.vue';
import { useTheme } from '@/composables/useTheme';

const route = useRoute();
const shell = ref<HTMLElement | null>(null);
const { toggleTheme } = useTheme();

/* Set once the page is interactive: only then do sections start hidden and reveal on scroll. */
const ready = ref(false);
let observer: IntersectionObserver | undefined;

onMounted(() => {
    if (!('IntersectionObserver' in window)) {
        return;
    }
    ready.value = true;
    observer = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-in');
                    observer?.unobserve(entry.target);
                }
            }
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.1 },
    );
    const observe = () => shell.value?.querySelectorAll('[data-reveal]:not(.is-in)').forEach((el) => observer?.observe(el));
    observe();
    watch(
        () => route.path,
        () => requestAnimationFrame(observe),
    );
});

onBeforeUnmount(() => observer?.disconnect());

watch(
    () => route.path,
    () => shell.value?.scrollTo({ top: 0 }),
);
</script>

<template>
    <div ref="shell" class="mk" :class="{ 'mk--ready': ready }">
        <header class="mk-top">
            <div class="mk-top-inner">
                <RouterLink :to="{ name: 'home' }" class="mk-brand" aria-label="Juicy Loops home">
                    <JuicyLogo />
                </RouterLink>
                <nav class="mk-nav" aria-label="Site">
                    <a href="https://github.com/daspete/juicyloops2026/discussions" target="_blank" rel="noopener noreferrer" class="mk-navlink">Discussions</a>
                    <RouterLink :to="{ name: 'imprint' }" class="mk-navlink">Imprint</RouterLink>
                    <button type="button" class="mk-theme" aria-label="Switch between light and dark" @click="toggleTheme">
                        <svg class="mk-theme-sun" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                            <circle cx="12" cy="12" r="4.2" fill="currentColor" />
                            <g stroke="currentColor" stroke-width="2" stroke-linecap="round">
                                <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
                            </g>
                        </svg>
                        <svg class="mk-theme-moon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                            <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="currentColor" />
                        </svg>
                    </button>
                    <RouterLink :to="{ name: 'app.index' }" class="mk-btn mk-btn--small">Open the studio</RouterLink>
                </nav>
            </div>
        </header>

        <RouterView />

        <footer class="mk-foot">
            <span>Made with love in Vienna by <a href="https://daspete.at" target="_blank" rel="noopener noreferrer">Pete</a></span>
            <span class="mk-foot-links">
                <a href="https://github.com/daspete/juicyloops2026" target="_blank" rel="noopener noreferrer">Source</a>
                <a href="https://github.com/daspete/juicyloops2026/discussions" target="_blank" rel="noopener noreferrer">Discussions</a>
                <RouterLink :to="{ name: 'imprint' }">Imprint</RouterLink>
            </span>
        </footer>
    </div>
</template>
