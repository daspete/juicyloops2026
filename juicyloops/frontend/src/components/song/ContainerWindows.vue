<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useContainerWindows } from '@/composables/useContainerWindows';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import ContainerWindow from './ContainerWindow.vue';
import { containerHue } from './containerHue';

/**
 * The layer the container windows float in, over the whole song view. It knows the view's size (windows stay
 * inside it) and where the song plays each container, and it hands the keyboard back to the song editor once a
 * click lands outside every window.
 */
const { containers, song, currentStep, isPlaying, mode } = useJuicyLoops();
const { windows, fit, setActive } = useContainerWindows();

const layer = ref<HTMLElement | null>(null);
const area = reactive({ width: 0, height: 0 });

/** Every container the song plays at the current step, with the step it plays it at. */
const playing = computed(() => (isPlaying.value && mode.value === 'song' ? song.value.playingAt(currentStep.value) : new Map<string, number>()));

const entries = computed(() =>
    windows.value.map((state) => ({
        state,
        container: containers.value.find((container) => container.id === state.containerId)!,
        hue: containerHue(containers.value, state.containerId),
    })),
);

let observer: ResizeObserver | null = null;

const measure = () => {
    if (!layer.value) {
        return;
    }
    area.width = layer.value.clientWidth;
    area.height = layer.value.clientHeight;
    windows.value.forEach((state) => fit(state, area));
};

const onPointerDown = (event: PointerEvent) => {
    if (!(event.target as HTMLElement | null)?.closest('.cwin')) {
        setActive(null);
    }
};

onMounted(() => {
    measure();
    observer = new ResizeObserver(measure);
    observer.observe(layer.value!);
    window.addEventListener('pointerdown', onPointerDown, true);
});

onBeforeUnmount(() => {
    observer?.disconnect();
    window.removeEventListener('pointerdown', onPointerDown, true);
    setActive(null);
});

/** The layer's size, for opening a window in the right place. */
defineExpose({ area });
</script>

<template>
    <div ref="layer" class="cwin-layer">
        <ContainerWindow
            v-for="entry in entries"
            :key="entry.state.containerId"
            :state="entry.state"
            :container="entry.container"
            :hue="entry.hue"
            :step="playing.get(entry.state.containerId) ?? null"
            :area="area"
        />
    </div>
</template>
