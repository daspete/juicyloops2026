import { shallowRef } from 'vue';
import type { EffectKey } from '@/juicyloops/effects/definitions';
import type { Effects } from '@/juicyloops/effects/effects';

/** A device copied from one rack, to paste into any other (Copy in a card's menu, Paste on the rack's add card). */
export interface CopiedDevice {
    effect: EffectKey;
    label: string;
    params: Record<string, number>;
    bypassed: boolean;
}

export const deviceClipboard = shallowRef<CopiedDevice | null>(null);

export const copyDevice = (effects: Effects, slotId: string): void => {
    const effect = effects.effectOf(slotId);
    if (effect) {
        deviceClipboard.value = { effect, label: effects.slotLabel(slotId), params: effects.paramsOf(slotId), bypassed: effects.isBypassed(slotId) };
    }
};

/** Adds the copied device to a rack at `index` (the end by default). Returns the new slot id. */
export const pasteDevice = (effects: Effects, index?: number): string | null => {
    const copied = deviceClipboard.value;
    if (!copied) {
        return null;
    }
    const id = effects.add(copied.effect, index, copied.params);
    effects.setBypassed(id, copied.bypassed);
    return id;
};
