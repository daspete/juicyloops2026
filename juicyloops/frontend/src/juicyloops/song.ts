import { createId } from './audio';

/** One slot of the arrangement. Every section is one full pass of the pattern (`STEP_COUNT` steps). */
export interface SongSection {
    readonly id: string;
    /** Ids of the track containers that play in this section. */
    readonly containerIds: Set<string>;
}

export const DEFAULT_SECTION_COUNT = 4;

const createSection = (containerIds: Iterable<string> = []): SongSection => ({ id: createId(), containerIds: new Set(containerIds) });

/**
 * The arrangement: a list of sections, each of which switches a subset of the track containers on.
 *
 * Pure data, no audio. The sequencer reads it while playing in song mode,
 * the song editor edits it. A song always has at least one section.
 */
export class Song {
    readonly sections: SongSection[] = [];

    constructor(sectionCount = DEFAULT_SECTION_COUNT) {
        for (let i = 0; i < Math.max(1, sectionCount); i++) {
            this.sections.push(createSection());
        }
    }

    get length(): number {
        return this.sections.length;
    }

    /** Whether the container plays in the section. Out-of-range sections never play anything. */
    plays(sectionIndex: number, containerId: string): boolean {
        return this.sections[sectionIndex]?.containerIds.has(containerId) ?? false;
    }

    /** True when no container is placed anywhere. */
    get isEmpty(): boolean {
        return this.sections.every((section) => section.containerIds.size === 0);
    }

    setPlays(sectionIndex: number, containerId: string, plays: boolean): void {
        const section = this.sections[sectionIndex];
        if (!section) {
            return;
        }

        if (plays) {
            section.containerIds.add(containerId);
        } else {
            section.containerIds.delete(containerId);
        }
    }

    toggle(sectionIndex: number, containerId: string): void {
        this.setPlays(sectionIndex, containerId, !this.plays(sectionIndex, containerId));
    }

    /** Switches a container on (or off) in every section. */
    setPlaysEverywhere(containerId: string, plays: boolean): void {
        this.sections.forEach((_, index) => this.setPlays(index, containerId, plays));
    }

    /** Number of sections in which the container plays. */
    countSections(containerId: string): number {
        return this.sections.filter((section) => section.containerIds.has(containerId)).length;
    }

    /** Appends an empty section, or inserts it at `index`. */
    addSection(index = this.sections.length): SongSection {
        const section = createSection();
        this.sections.splice(index, 0, section);
        return section;
    }

    /** Inserts a copy right after the original. */
    duplicateSection(id: string): SongSection | null {
        const index = this.indexOf(id);
        if (index === -1) {
            return null;
        }

        const copy = createSection(this.sections[index]!.containerIds);
        this.sections.splice(index + 1, 0, copy);
        return copy;
    }

    /** Removes a section unless it is the last one. */
    removeSection(id: string): void {
        const index = this.indexOf(id);
        if (index === -1 || this.sections.length === 1) {
            return;
        }

        this.sections.splice(index, 1);
    }

    /** Swaps a section with its right (`1`) or left (`-1`) neighbour. */
    moveSection(id: string, direction: 1 | -1): void {
        const index = this.indexOf(id);
        const target = index + direction;
        if (index === -1 || target < 0 || target >= this.sections.length) {
            return;
        }

        [this.sections[index], this.sections[target]] = [this.sections[target]!, this.sections[index]!];
    }

    /** Forgets a container everywhere, e.g. after it was deleted. */
    removeContainer(containerId: string): void {
        this.sections.forEach((section) => section.containerIds.delete(containerId));
    }

    private indexOf(id: string): number {
        return this.sections.findIndex((section) => section.id === id);
    }
}
