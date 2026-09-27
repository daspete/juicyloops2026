import { STEP_COUNT } from '@/juicyloops/constants';
import type { TrackContainer } from '@/juicyloops/trackContainer';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { computed, inject, provide, type ComputedRef, type InjectionKey } from 'vue';
import { useJuicyLoops } from './useJuicyLoops';

/**
 * Which container a group of track rows shows, and where its playhead is.
 *
 * The track view shows the current container and loops it, so its playhead is the running step. A container window
 * in the song view shows any container, and its playhead is wherever the song plays that container right now (a
 * clip plays the container from the clip's own start), or nowhere while no clip of it sounds.
 *
 * The rows get both through `provide`/`inject`, so the same row components serve either place.
 */
export interface ContainerView {
    container: ComputedRef<TrackContainer>;
    /** The running step the container plays at, null while it is silent. Tracks wrap it around their own length. */
    step: ComputedRef<number | null>;
}

const KEY: InjectionKey<ContainerView> = Symbol('container-view');

export const provideContainerView = (container: () => TrackContainer, step: () => number | null): ContainerView => {
    const view: ContainerView = { container: computed(container), step: computed(step) };
    provide(KEY, view);
    return view;
};

/** The view the rows sit in; outside of one, the current container as the track view loops it. */
export const useContainerView = (): ContainerView => {
    const view = inject(KEY, null);
    if (view) {
        return view;
    }
    const { currentContainer, currentStep, isPlaying } = useJuicyLoops();
    return { container: currentContainer, step: computed(() => (isPlaying.value ? currentStep.value : null)) };
};

/** The playhead of one track row: inside its own pattern, and inside the section the ruler shows. -1 while silent. */
export const useTrackPlayhead = (track: () => BaseTrack) => {
    const { step } = useContainerView();
    return {
        currentTick: computed(() => (step.value === null ? -1 : track().stepOf(step.value))),
        sectionStep: computed(() => (step.value === null ? -1 : step.value % STEP_COUNT)),
    };
};
