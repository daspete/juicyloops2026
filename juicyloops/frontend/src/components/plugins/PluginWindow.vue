<script setup lang="ts">
import { Icon } from '@iconify/vue';
import type { WamNode, WebAudioModule } from '@webaudiomodules/api';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePlugins, type PluginWindowEntry } from '@/composables/usePlugins';
import { pluginStatus } from '@/juicyloops/plugins/pluginStatus';

/**
 * A plugin's own interface in a floating window: drag it by its title, close it with ×. The plugin's state is read
 * back into the session every few seconds while it is open and when it closes (a plugin tells nobody when it changes).
 */
const props = defineProps<{
    entry: PluginWindowEntry;
    /** Where it opens, offset per window so they do not stack exactly. */
    index: number;
}>();

const { closeWindow, openWindow } = usePlugins();

const REFRESH_MS = 3000;

const host = ref<HTMLElement | null>(null);
const position = ref({ x: 120 + props.index * 28, y: 90 + props.index * 28 });
const status = computed(() => pluginStatus(props.entry.key));
/** Set when the plugin has no window of its own, or could not show it. */
const guiMissing = ref(false);

let gui: { module: WebAudioModule<WamNode>; element: Element } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const mountGui = async () => {
    const module = props.entry.module();
    if (!module || gui || !host.value) {
        return;
    }
    try {
        const element = await module.createGui();
        if (!host.value) {
            module.destroyGui(element);
            return;
        }
        host.value.replaceChildren(element);
        gui = { module, element };
        guiMissing.value = false;
        // Some plugins without an interface hand back an empty element rather than failing.
        requestAnimationFrame(() => {
            const { width, height } = element.getBoundingClientRect();
            if (gui?.element === element && (width < 8 || height < 8)) {
                guiMissing.value = true;
            }
        });
    } catch (error) {
        console.warn('The plugin could not show its window.', error);
        guiMissing.value = true;
    }
};

const unmountGui = () => {
    if (gui) {
        try {
            gui.module.destroyGui(gui.element);
        } catch {
            /* the plugin is gone already */
        }
        gui.element.remove();
        gui = null;
    }
};

// A plugin still loading shows its window once it is ready; one loaded again (undo, preset) gets a new window.
watch(status, (next, previous) => {
    if (next?.state === 'ready' && previous?.state !== 'ready') {
        unmountGui();
        void mountGui();
    }
});

onMounted(() => {
    void mountGui();
    timer = setInterval(() => props.entry.refresh?.(), REFRESH_MS);
});

onBeforeUnmount(() => {
    if (timer) {
        clearInterval(timer);
    }
    unmountGui();
});

/* ---- dragging by the title ---- */

let drag: { x: number; y: number; left: number; top: number } | null = null;

const startDrag = (event: PointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) {
        return;
    }
    drag = { x: event.clientX, y: event.clientY, left: position.value.x, top: position.value.y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    openWindow(props.entry);
};

const moveDrag = (event: PointerEvent) => {
    if (drag) {
        position.value = {
            x: Math.min(window.innerWidth - 80, Math.max(-200, drag.left + event.clientX - drag.x)),
            y: Math.min(window.innerHeight - 40, Math.max(0, drag.top + event.clientY - drag.y)),
        };
    }
};

const endDrag = () => {
    drag = null;
};
</script>

<template>
    <section class="plugin-window" :style="{ left: `${position.x}px`, top: `${position.y}px` }" role="dialog" :aria-label="`${props.entry.title} plugin`" @pointerdown="openWindow(props.entry)">
        <header class="plugin-window-head" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag">
            <Icon icon="mdi:puzzle-outline" class="w-4 h-4" />
            <span class="plugin-window-title">{{ props.entry.title }}</span>
            <button type="button" class="iconbtn" :aria-label="`Close ${props.entry.title}`" @click="closeWindow(props.entry.key)">
                <Icon icon="mdi:close" class="w-4 h-4" />
            </button>
        </header>
        <div class="plugin-window-body">
            <p v-if="status?.state === 'loading'" class="plugin-empty"><Icon icon="mdi:loading" class="w-4 h-4 animate-spin" /> Loading the plugin…</p>
            <p v-else-if="status?.state === 'error'" class="plugin-error">{{ status.message }}</p>
            <p v-else-if="guiMissing" class="plugin-empty">This plugin has no window of its own. It plays with its default sound.</p>
            <div ref="host" class="plugin-window-gui"></div>
        </div>
    </section>
</template>
