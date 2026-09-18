import { ref } from 'vue';

/**
 * A tiny beat bus for the home page: the demo grid calls `pulse` on every step it plays,
 * the hero waveform reads `energy` and lets it decay. Nothing else needs to know about either.
 */
const energy = ref(0);

const pulse = (amount = 1) => {
    energy.value = Math.min(2, energy.value + amount);
};

/** Called by whoever animates: drops the energy toward zero a little each frame. */
const decay = (seconds: number) => {
    energy.value = Math.max(0, energy.value - energy.value * Math.min(1, seconds * 6));
};

export const useHeroPulse = () => ({ energy, pulse, decay });
