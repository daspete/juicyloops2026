<script setup lang="ts">
import { onMounted } from 'vue';

onMounted(() => {
    const existingScript = document.querySelector('script[src="https://giscus.app/client.js"]');
    if (existingScript) {
        existingScript.remove();
    }

    const script = document.createElement('script');
    script.src = 'https://giscus.app/client.js';
    script.setAttribute('data-repo', 'daspete/juicyloops2026');
    script.setAttribute('data-repo-id', 'R_kgDORQidlA');
    script.setAttribute('data-category', 'Q&A');
    script.setAttribute('data-category-id', 'DIC_kwDORQidlM4C2zC3');
    script.setAttribute('data-mapping', 'pathname');
    script.setAttribute('data-strict', '0');
    script.setAttribute('data-reactions-enabled', '1');
    script.setAttribute('data-emit-metadata', '0');
    script.setAttribute('data-input-position', 'top');
    script.setAttribute('data-theme', 'preferred_color_scheme');
    script.setAttribute('data-lang', 'en');
    script.setAttribute('data-loading', 'lazy');
    script.crossOrigin = 'anonymous';
    script.async = true;

    document.querySelector('.giscus-container')?.appendChild(script);
})
</script>

<template>
    <div class="giscus-container"></div>
</template>
