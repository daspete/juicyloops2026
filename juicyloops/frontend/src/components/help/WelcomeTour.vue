<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useHelp } from '@/composables/useHelp';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useViewport } from '@/composables/useViewport';
import { useWorkspace } from '@/composables/useWorkspace';

/**
 * The welcome tour: every part of the studio, one step at a time. Each step lights up the part it talks about (a
 * spotlight over a dimmed studio) and explains it in a card beside it. A step can prepare the studio first (open the
 * dock on a tab, open the Inspector, add a first track so there is something to show). Steps whose part is not on
 * this screen (the song view in Quick mode, the MIDI bar on a phone) are skipped.
 *
 * → or Enter goes on, ← goes back, Esc ends it. It starts by itself on the first visit and replays from the help dialog.
 */
interface TourStep {
    id: string;
    title: string;
    icon: string;
    /** Paragraphs. */
    body: readonly string[];
    /** Tips shown as a short list under the text. */
    tips?: readonly string[];
    /** The part to light up; none shows the card in the middle. */
    target?: string;
    /** Only in Pro mode. */
    pro?: boolean;
    /** Makes the studio show what the step is about. */
    before?: () => void | Promise<void>;
}

const { isTourOpen, endTour } = useHelp();
const { tracks, addTrack } = useJuicyLoops();
const { isPro, openDock, closeDock, isInspectorOpen, isBrowserOpen, selectTrack } = useWorkspace();
const { isPhone } = useViewport();
const route = useRoute();
const router = useRouter();

const toTracks = async () => {
    if (route.name !== 'app.index') {
        await router.push({ name: 'app.index' });
    }
};

/** The first track, added when there is none, with a few steps on so pressing play makes a sound. */
const ensureTrack = async () => {
    await toTracks();
    if (!tracks.value.length) {
        addTrack('synth');
        tracks.value[0]?.activateEveryNth(4);
    }
    const first = tracks.value[0];
    if (first) {
        selectTrack(first.id);
    }
    isInspectorOpen.value = false;
    closeDock();
};

const STEPS: readonly TourStep[] = [
    {
        id: 'welcome',
        title: 'Welcome to Juicy Loops',
        icon: 'mdi:hand-wave-outline',
        body: [
            'A quick tour of the studio: where everything is and how to use it. It takes about two minutes.',
            'Use the buttons below, or the arrow keys. Esc ends the tour; you can replay it any time from Help (?).',
        ],
    },
    {
        id: 'transport',
        title: 'Play, record and tempo',
        icon: 'mdi:play-circle-outline',
        target: '.transport',
        before: async () => {
            await toTracks();
            closeDock();
        },
        body: ['The big button plays and stops everything, the red one records from a MIDI keyboard or a microphone.'],
        tips: ['Space plays and stops, R records', 'Drag the BPM number up or down, or tap the tempo', 'Undo and redo keep every change'],
    },
    {
        id: 'add',
        title: 'Add a track',
        icon: 'mdi:plus-circle-outline',
        target: '.addrow, .hero-cards',
        before: toTracks,
        body: ['Every track is its own loop. A Synth plays notes, a Sampler plays a sound file, a Mic records you and loops it.'],
        tips: ['Drop an audio file on a Sampler track to load it'],
    },
    {
        id: 'track',
        title: 'Your track',
        icon: 'mdi:dots-grid',
        target: '.track',
        before: ensureTrack,
        body: [
            'Tap a pad to switch a step on, drag across pads to paint several. We added a Synth track for you if you had none.',
            'On the left, the track head: M mutes, S solos (only soloed tracks play), the slider sets its level.',
        ],
        tips: ['Right-click the head (or ⋯) to duplicate, export or remove the track'],
    },
    {
        id: 'tools',
        title: 'Look deeper into a track',
        icon: 'mdi:chart-bar',
        target: '.track .track-toolbar',
        before: ensureTrack,
        body: ['These buttons open lanes under the steps: the piano roll for pitches, Velocity for how loud each note plays, Automate to draw any knob over the loop.'],
        tips: ['Velocity: drag a stem, or hold Alt and drag a straight ramp', 'Devices opens the sound and effects of the track'],
    },
    {
        id: 'browser',
        title: 'Your samples',
        icon: 'mdi:folder-music-outline',
        target: '.dock--browser',
        before: async () => {
            await toTracks();
            isBrowserOpen.value = true;
        },
        body: ['Add a folder of samples from your computer. Click a sample to hear it, right-click it to put it on a new track.'],
        tips: ['B shows and hides the browser'],
    },
    {
        id: 'inspector',
        title: 'The Inspector',
        icon: 'mdi:information-outline',
        target: 'aside.inspector',
        before: async () => {
            await ensureTrack();
            isInspectorOpen.value = true;
        },
        body: [
            'Everything about the selected track that is not its sound: its name, how long its loop is, quick fills (every 2nd, 4th, 8th step), random patterns and how its notes behave.',
            'It opens by itself when you select a track.',
        ],
        tips: ['I shows and hides the Inspector'],
    },
    {
        id: 'devices',
        title: 'Devices: shape the sound',
        icon: 'mdi:tune-variant',
        target: '.bdock',
        before: async () => {
            await ensureTrack();
            isInspectorOpen.value = false;
            openDock('devices');
        },
        body: [
            'The signal flows from left to right: the instrument first, then the effects, then the channel with its level and pan.',
            'Add effects with the + card. The power button bypasses one and keeps its settings, ⋯ has presets.',
        ],
        tips: ['Drag a device to reorder it, Alt+drag copies it', 'Simple shows the main knobs, Full shows every knob', 'D opens the devices'],
    },
    {
        id: 'mixer',
        title: 'The mixer',
        icon: 'mdi:tune-vertical',
        target: '.bdock',
        before: async () => {
            await toTracks();
            openDock('mixer');
        },
        body: ['Every channel as a strip: the fader and its meter, pan, mute and solo. Balance your tracks here while the loop plays.'],
        tips: ['In Pro: every container, the sends A and B to a shared reverb and echo, and the master', 'M opens the mixer; drag the top edge to make it taller'],
    },
    {
        id: 'containers',
        title: 'Containers',
        icon: 'mdi:view-grid-outline',
        target: '.scenes',
        pro: true,
        before: async () => {
            await toTracks();
            closeDock();
        },
        body: ['A container is a group of tracks that loop together: a verse, a chorus, a drop. Make as many as you like and switch between them here.'],
        tips: ['Channel: level, pan and effects of the whole container'],
    },
    {
        id: 'song',
        title: 'Arrange the song',
        icon: 'mdi:view-sequential-outline',
        target: '.viewswitch',
        pro: true,
        body: ['In the song view you place containers on lanes to build a whole song, and draw automation over its timeline.'],
        tips: ['Double-click a clip to edit its tracks right there'],
    },
    {
        id: 'mode',
        title: 'Quick or Pro',
        icon: 'mdi:lightning-bolt',
        target: '.modeswitch',
        before: closeDock,
        body: ['Quick keeps it simple: tracks, sounds and a small mixer. Pro adds containers, the song arranger, sends and automation. Switch any time; nothing is lost.'],
    },
    {
        id: 'file',
        title: 'Save and export',
        icon: 'mdi:content-save-outline',
        target: '.filebar',
        body: ['Name your session, save it as one file with all its samples and recordings, open it again later, or export it as WAV or MP3.'],
        tips: ['Ctrl+S saves, Ctrl+E exports'],
    },
    {
        id: 'midi',
        title: 'MIDI keyboards and controllers',
        icon: 'mdi:piano',
        target: '.midibar',
        body: ['Connect a MIDI keyboard to play the selected track, record into it, or map your controller\'s knobs to any knob in the studio with MIDI learn.'],
    },
    {
        id: 'help',
        title: 'That\'s it. Have fun!',
        icon: 'mdi:help-circle-outline',
        target: '.helpbtn',
        body: ['Press ? or this button any time for every keyboard shortcut, and to replay this tour.'],
    },
];

const steps = computed(() => STEPS.filter((step) => !step.pro || isPro.value));
const index = ref(0);
const step = computed(() => steps.value[index.value]!);
const isLast = computed(() => index.value === steps.value.length - 1);

/* ---- where the spotlight and the card go ---- */

const PAD = 6;
const rect = ref<DOMRect | null>(null);
const card = ref<HTMLElement | null>(null);
const cardPos = ref<{ left: number; top: number; placement: 'center' | 'below' | 'above' | 'left' | 'right' }>({ left: 0, top: 0, placement: 'center' });

const findTarget = (selector?: string): HTMLElement | null => {
    if (!selector) {
        return null;
    }
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        const box = element.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
            return element;
        }
    }
    return null;
};

/** Where the card fits best: below, above, then beside the target; the middle of the screen without one. */
const place = () => {
    const target = rect.value;
    const box = card.value?.getBoundingClientRect();
    const width = box?.width ?? 360;
    const height = box?.height ?? 220;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 12;
    const clampX = (x: number) => Math.min(vw - width - margin, Math.max(margin, x));
    const clampY = (y: number) => Math.min(vh - height - margin, Math.max(margin, y));
    if (!target) {
        cardPos.value = { left: (vw - width) / 2, top: Math.max(margin, (vh - height) / 2), placement: 'center' };
        return;
    }
    const gap = 14;
    if (target.bottom + gap + height + margin <= vh) {
        cardPos.value = { left: clampX(target.left + target.width / 2 - width / 2), top: target.bottom + gap, placement: 'below' };
    } else if (target.top - gap - height >= margin) {
        cardPos.value = { left: clampX(target.left + target.width / 2 - width / 2), top: target.top - gap - height, placement: 'above' };
    } else if (target.right + gap + width + margin <= vw) {
        cardPos.value = { left: target.right + gap, top: clampY(target.top + target.height / 2 - height / 2), placement: 'right' };
    } else if (target.left - gap - width >= margin) {
        cardPos.value = { left: target.left - gap - width, top: clampY(target.top + target.height / 2 - height / 2), placement: 'left' };
    } else {
        // The target fills the screen (a panel on a phone): the card sits over its lower part.
        cardPos.value = { left: clampX((vw - width) / 2), top: clampY(vh - height - 24), placement: 'center' };
    }
};

/* Follows the target while it moves (a dock opening, a panel sliding in, the window resizing). */
let frame = 0;
const track = () => {
    const element = findTarget(step.value?.target);
    const next = element?.getBoundingClientRect() ?? null;
    const previous = rect.value;
    if (
        !next !== !previous ||
        (next && previous && (next.x !== previous.x || next.y !== previous.y || next.width !== previous.width || next.height !== previous.height))
    ) {
        rect.value = next;
    }
    place();
    frame = requestAnimationFrame(track);
};

const spotlight = computed(() => {
    const target = rect.value;
    if (!target) {
        return null;
    }
    const left = Math.max(4, target.left - PAD);
    const top = Math.max(4, target.top - PAD);
    return {
        left: `${left}px`,
        top: `${top}px`,
        width: `${Math.min(window.innerWidth - 4, target.right + PAD) - left}px`,
        height: `${Math.min(window.innerHeight - 4, target.bottom + PAD) - top}px`,
    };
});

/* ---- going through the steps ---- */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shows step `to`, preparing the studio; a step whose part is not on this screen is passed over in the same direction. */
const go = async (to: number, direction: 1 | -1 = 1) => {
    let next = to;
    while (next >= 0 && next < steps.value.length) {
        const candidate = steps.value[next]!;
        await candidate.before?.();
        await nextTick();
        if (!candidate.target || findTarget(candidate.target) || (await wait(250), findTarget(candidate.target))) {
            index.value = next;
            await nextTick();
            card.value?.querySelector<HTMLElement>('.tour-next')?.focus({ preventScroll: true });
            return;
        }
        next += direction;
    }
    if (next >= steps.value.length) {
        finish();
    }
};

const nextStep = () => (isLast.value ? finish() : void go(index.value + 1, 1));
const previousStep = () => index.value > 0 && void go(index.value - 1, -1);

const finish = () => {
    closeDock();
    endTour();
};

const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish();
    } else if (event.key === 'ArrowRight' || (event.key === 'Enter' && !(event.target as HTMLElement).closest?.('button'))) {
        event.preventDefault();
        event.stopPropagation();
        nextStep();
    } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        previousStep();
    }
};

watch(
    isTourOpen,
    (open) => {
        cancelAnimationFrame(frame);
        window.removeEventListener('keydown', onKey, true);
        if (open) {
            index.value = 0;
            rect.value = null;
            void go(0);
            window.addEventListener('keydown', onKey, true);
            frame = requestAnimationFrame(track);
        }
    },
    { immediate: true },
);

onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    window.removeEventListener('keydown', onKey, true);
});
</script>

<template>
    <Teleport to="body">
        <div v-if="isTourOpen" class="tour" :class="{ 'tour--phone': isPhone }" role="dialog" aria-modal="true" :aria-label="`Tour: ${step.title}`">
            <div v-if="spotlight" class="tour-spot" :style="spotlight"></div>
            <div v-else class="tour-dim"></div>

            <section ref="card" class="tour-card" :data-placement="cardPos.placement" :style="{ left: `${cardPos.left}px`, top: `${cardPos.top}px` }">
                <header class="tour-head">
                    <span class="tour-icon"><Icon :icon="step.icon" class="w-5 h-5" /></span>
                    <h2 class="tour-title">{{ step.title }}</h2>
                    <button type="button" class="iconbtn" aria-label="End the tour" v-tooltip.bottom="'End the tour (Esc)'" @click="finish">
                        <Icon icon="mdi:close" class="w-4 h-4" />
                    </button>
                </header>
                <p v-for="(paragraph, paragraphIndex) in step.body" :key="paragraphIndex" class="tour-text">{{ paragraph }}</p>
                <ul v-if="step.tips?.length" class="tour-tips">
                    <li v-for="tip in step.tips" :key="tip"><Icon icon="mdi:lightbulb-on-outline" class="w-3.5 h-3.5" /> {{ tip }}</li>
                </ul>
                <div class="tour-progress">
                    <div class="tour-dots" aria-hidden="true">
                        <span v-for="(item, dotIndex) in steps" :key="item.id" class="tour-dot" :data-active="dotIndex === index" :data-done="dotIndex < index"></span>
                    </div>
                    <span class="tour-count">Step {{ index + 1 }} of {{ steps.length }}</span>
                </div>
                <footer class="tour-foot">
                    <button v-if="index > 0" type="button" class="tour-button tour-button--ghost" @click="previousStep">Back</button>
                    <button v-else type="button" class="tour-button tour-button--ghost" @click="finish">Skip</button>
                    <button type="button" class="tour-button tour-next" @click="nextStep">{{ isLast ? 'Done' : index === 0 ? 'Show me' : 'Next' }}</button>
                </footer>
            </section>
        </div>
    </Teleport>
</template>
