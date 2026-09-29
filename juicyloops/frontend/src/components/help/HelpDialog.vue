<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useHelp } from '@/composables/useHelp';
import { keyLabel, SHORTCUT_GROUPS } from './shortcuts';

/**
 * The help dialog: every keyboard shortcut and mouse gesture, grouped by where it works, with a filter, and the button
 * that replays the welcome tour. Opens with `?` or the help button in the top bar; Esc or a click beside it closes it.
 */
const { isHelpOpen, startTour } = useHelp();

const query = ref('');
const search = ref<HTMLInputElement | null>(null);
const dialog = ref<HTMLElement | null>(null);

const groups = computed(() => {
    const words = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
        return SHORTCUT_GROUPS;
    }
    return SHORTCUT_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => {
            const text = `${group.title} ${item.does} ${item.keys.flat().map(keyLabel).join(' ')}`.toLowerCase();
            return words.every((word) => text.includes(word));
        }),
    })).filter((group) => group.items.length);
});

const close = () => {
    isHelpOpen.value = false;
};

const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
        event.stopPropagation();
        close();
    }
};

/** Where the focus was before the dialog took it, to give it back. */
let returnFocus: HTMLElement | null = null;

watch(isHelpOpen, async (open) => {
    if (open) {
        returnFocus = document.activeElement as HTMLElement | null;
        query.value = '';
        window.addEventListener('keydown', onKey, true);
        await nextTick();
        search.value?.focus();
    } else {
        window.removeEventListener('keydown', onKey, true);
        returnFocus?.focus?.();
    }
});

onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));

/** Tab stays inside the dialog. */
const trapTab = (event: KeyboardEvent) => {
    const focusable = [...(dialog.value?.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])') ?? [])];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
        return;
    }
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
};
</script>

<template>
    <Teleport to="body">
        <Transition name="helpfade">
            <div v-if="isHelpOpen" class="help-backdrop" @pointerdown.self="close">
                <section ref="dialog" class="help" role="dialog" aria-modal="true" aria-labelledby="help-title" @keydown.tab="trapTab">
                    <header class="help-head">
                        <span class="help-badge"><Icon icon="mdi:help" class="w-5 h-5" /></span>
                        <div class="help-title-wrap">
                            <h2 id="help-title" class="help-title">Help</h2>
                            <p class="help-sub">Every shortcut, and a guided tour of the studio.</p>
                        </div>
                        <button type="button" class="iconbtn" aria-label="Close help" v-tooltip.bottom="'Close (Esc)'" @click="close">
                            <Icon icon="mdi:close" class="w-5 h-5" />
                        </button>
                    </header>

                    <div class="help-tour">
                        <div>
                            <div class="help-tour-title">New here, or forgot where something is?</div>
                            <div class="help-tour-text">The tour walks you through every part of the studio in about two minutes.</div>
                        </div>
                        <button type="button" class="help-tour-button" @click="startTour">
                            <Icon icon="mdi:play-circle-outline" class="w-5 h-5" />
                            <span>Start the tour</span>
                        </button>
                    </div>

                    <div class="help-search">
                        <Icon icon="mdi:magnify" class="w-4 h-4" />
                        <input ref="search" v-model="query" type="search" class="help-search-input" placeholder="Find a shortcut: undo, zoom, velocity…" aria-label="Find a shortcut" />
                    </div>

                    <div class="help-body">
                        <p v-if="!groups.length" class="help-empty">No shortcut matches “{{ query }}”.</p>
                        <section v-for="group in groups" :key="group.title" class="help-group">
                            <h3 class="help-group-title"><Icon :icon="group.icon" class="w-4 h-4" /> {{ group.title }}</h3>
                            <p class="help-group-where">{{ group.where }}</p>
                            <dl class="help-list">
                                <template v-for="(item, index) in group.items" :key="index">
                                    <dt class="help-keys">
                                        <template v-for="(combo, comboIndex) in item.keys" :key="comboIndex">
                                            <span v-if="comboIndex" class="help-or">or</span>
                                            <span class="help-combo">
                                                <template v-for="(key, keyIndex) in combo" :key="keyIndex">
                                                    <span v-if="keyIndex" class="help-plus">+</span>
                                                    <kbd>{{ keyLabel(key) }}</kbd>
                                                </template>
                                            </span>
                                        </template>
                                    </dt>
                                    <dd class="help-does">{{ item.does }}</dd>
                                </template>
                            </dl>
                        </section>
                    </div>
                </section>
            </div>
        </Transition>
    </Teleport>
</template>
