<script setup lang="ts">
import { heldKeysOf } from '@/juicyloops/midi/heldKeys';
import type { HeldKey } from '@/juicyloops/midi/liveNotes';
import { computed } from 'vue';
import type { RollRow } from '../PianoRoll.vue';

/**
 * Lights the rows of the keys MIDI plays on the track right now, like a DAW's keyboard: the key in the key column
 * (`part="keys"`) or a band across the notes area (`part="rows"`). A key the sustain pedal holds after it came up is
 * drawn dimmer. Only live MIDI notes light up, not the pattern playing.
 *
 * Its own component, reading only the track's entry in `midi/heldKeys.ts` (which changes on note-on/off and pedal
 * moves, never per frame): the roll's keys, grid and note bars do not re-render when a key goes down.
 */
const props = defineProps<{
    trackId: string;
    rows: readonly RollRow[];
    /** The row a played note lights, -1 when the roll has none for it (a sample roll maps keys onto slices). */
    rowAt: (note: string) => number;
    part: 'keys' | 'rows';
}>();

const lit = computed(() => {
    const rows = new Map<number, HeldKey>();
    for (const [note, state] of heldKeysOf(props.trackId)) {
        const index = props.rowAt(note);
        if (index >= 0 && rows.get(index) !== 'held') {
            rows.set(index, state);
        }
    }
    return [...rows].map(([index, state]) => ({ index, state, label: props.rows[index]?.label ?? '' }));
});
</script>

<template>
    <template v-if="props.part === 'keys'">
        <div v-for="row in lit" :key="row.index" class="proll-key-live" :data-state="row.state" :style="`--r:${row.index}`" aria-hidden="true">{{ row.label }}</div>
    </template>
    <template v-else>
        <div v-for="row in lit" :key="row.index" class="proll-live-row" :data-state="row.state" :style="`--r:${row.index}`" aria-hidden="true"></div>
    </template>
</template>
