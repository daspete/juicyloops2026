import { createId } from './audio';
import { createSongLane, type AutomationTarget, type SongAutomationLane } from './automation';

/** Steps per bar; the song grid snaps to beats of `SONG_SNAP` steps. */
export const SONG_STEPS_PER_BAR = 16;
export const SONG_SNAP = 4;

/**
 * One block on a song lane: a track container playing from `start` for `length` steps.
 * `offset` is where inside the container's patterns the clip begins, so a clip cut in two
 * keeps sounding like the uncut one.
 */
export interface SongClip {
    readonly id: string;
    containerId: string;
    start: number;
    length: number;
    offset: number;
}

/** A horizontal lane of clips, like a track in a DAW. Clips on one lane never overlap. */
export interface SongLane {
    readonly id: string;
    name: string;
    isMuted: boolean;
    readonly clips: SongClip[];
}

/** Snaps a step to the song grid. */
export const snapStep = (step: number): number => Math.max(0, Math.round(step / SONG_SNAP) * SONG_SNAP);

const createLane = (name: string): SongLane => ({ id: createId(), name, isMuted: false, clips: [] });

/**
 * The arrangement: lanes of clips on a shared timeline measured in steps, plus automation lanes
 * that draw a parameter of a track, a container or the master over the same timeline.
 *
 * Pure data, no audio. The sequencer reads it while playing in song mode,
 * the song editor edits it. A song always has at least one lane.
 */
export class Song {
    readonly lanes: SongLane[] = [];
    readonly automation: SongAutomationLane[] = [];

    constructor(laneCount = 1) {
        for (let i = 0; i < Math.max(1, laneCount); i++) {
            this.addLane();
        }
    }

    /** Length of the song in steps: the end of the last clip, rounded up to a whole bar. Zero when empty. */
    get length(): number {
        const end = Math.max(0, ...this.clips.map((clip) => clip.start + clip.length));
        return Math.ceil(end / SONG_STEPS_PER_BAR) * SONG_STEPS_PER_BAR;
    }

    get clips(): SongClip[] {
        return this.lanes.flatMap((lane) => lane.clips);
    }

    get isEmpty(): boolean {
        return this.lanes.every((lane) => lane.clips.length === 0);
    }

    /* ---- playback ---- */

    /**
     * What sounds at a step: for every container, the position inside its patterns.
     * Muted lanes stay silent, and a container placed on several lanes at once plays once.
     */
    playingAt(step: number): Map<string, number> {
        const result = new Map<string, number>();
        for (const lane of this.lanes) {
            if (lane.isMuted) {
                continue;
            }
            for (const clip of lane.clips) {
                if (step >= clip.start && step < clip.start + clip.length && !result.has(clip.containerId)) {
                    result.set(clip.containerId, step - clip.start + clip.offset);
                }
            }
        }
        return result;
    }

    /* ---- lanes ---- */

    addLane(name = `Lane ${this.lanes.length + 1}`): SongLane {
        const lane = createLane(name);
        this.lanes.push(lane);
        return lane;
    }

    getLane(id: string): SongLane | undefined {
        return this.lanes.find((lane) => lane.id === id);
    }

    /** Removes a lane with all its clips, unless it is the last one. */
    removeLane(id: string): void {
        const index = this.lanes.findIndex((lane) => lane.id === id);
        if (index === -1 || this.lanes.length === 1) {
            return;
        }
        this.lanes.splice(index, 1);
    }

    /** Moves a lane up (`-1`) or down (`1`). */
    moveLane(id: string, direction: 1 | -1): void {
        const index = this.lanes.findIndex((lane) => lane.id === id);
        const target = index + direction;
        if (index === -1 || target < 0 || target >= this.lanes.length) {
            return;
        }
        [this.lanes[index], this.lanes[target]] = [this.lanes[target]!, this.lanes[index]!];
    }

    /* ---- clips ---- */

    getClip(id: string): SongClip | undefined {
        return this.clips.find((clip) => clip.id === id);
    }

    laneOf(clipId: string): SongLane | undefined {
        return this.lanes.find((lane) => lane.clips.some((clip) => clip.id === clipId));
    }

    /** Whether a clip of `length` steps starting at `start` would be free of other clips on the lane (`ignoreId` excluded). */
    isFree(laneId: string, start: number, length: number, ignoreId?: string): boolean {
        const lane = this.getLane(laneId);
        return !!lane && lane.clips.every((clip) => clip.id === ignoreId || clip.start + clip.length <= start || clip.start >= start + length);
    }

    /** Places a container on a lane. Returns null when the spot is taken. */
    addClip(laneId: string, containerId: string, start: number, length: number): SongClip | null {
        const lane = this.getLane(laneId);
        const snapped = snapStep(start);
        const size = Math.max(SONG_SNAP, snapStep(length));
        if (!lane || !this.isFree(laneId, snapped, size)) {
            return null;
        }

        const clip: SongClip = { id: createId(), containerId, start: snapped, length: size, offset: 0 };
        lane.clips.push(clip);
        this.sortLane(lane);
        return clip;
    }

    /** Moves a clip to another start (and optionally lane). Refused when that spot is taken. */
    moveClip(id: string, start: number, laneId?: string): boolean {
        const from = this.laneOf(id);
        const clip = this.getClip(id);
        const to = laneId ? this.getLane(laneId) : from;
        const snapped = snapStep(start);
        if (!from || !clip || !to || !this.isFree(to.id, snapped, clip.length, id)) {
            return false;
        }

        if (to !== from) {
            from.clips.splice(from.clips.indexOf(clip), 1);
            to.clips.push(clip);
        }
        clip.start = snapped;
        this.sortLane(to);
        return true;
    }

    /** Drags the right edge: the clip ends at `end` (exclusive). Never shorter than one beat, never into a neighbour. */
    setClipEnd(id: string, end: number): void {
        const lane = this.laneOf(id);
        const clip = this.getClip(id);
        if (!lane || !clip) {
            return;
        }

        const next = lane.clips.find((other) => other.start >= clip.start + clip.length);
        const limit = next ? next.start : Number.POSITIVE_INFINITY;
        clip.length = Math.min(limit - clip.start, Math.max(SONG_SNAP, snapStep(end) - clip.start));
    }

    /** Drags the left edge: the clip starts at `start`, keeps its end, and its pattern stays where it was. */
    setClipStart(id: string, start: number): void {
        const lane = this.laneOf(id);
        const clip = this.getClip(id);
        if (!lane || !clip) {
            return;
        }

        const previous = [...lane.clips].reverse().find((other) => other.start + other.length <= clip.start);
        const end = clip.start + clip.length;
        const snapped = Math.min(end - SONG_SNAP, Math.max(previous ? previous.start + previous.length : 0, snapStep(start)));
        clip.offset += snapped - clip.start;
        clip.start = snapped;
        clip.length = end - snapped;
        this.sortLane(lane);
    }

    /** Cuts a clip in two at a step. Nothing happens on the clip's edges. Returns the new right half. */
    splitClip(id: string, at: number): SongClip | null {
        const lane = this.laneOf(id);
        const clip = this.getClip(id);
        const cut = snapStep(at);
        if (!lane || !clip || cut <= clip.start || cut >= clip.start + clip.length) {
            return null;
        }

        const right: SongClip = { id: createId(), containerId: clip.containerId, start: cut, length: clip.start + clip.length - cut, offset: clip.offset + cut - clip.start };
        clip.length = cut - clip.start;
        lane.clips.push(right);
        this.sortLane(lane);
        return right;
    }

    /** Copies a clip right behind itself, if there is room. */
    duplicateClip(id: string): SongClip | null {
        const lane = this.laneOf(id);
        const clip = this.getClip(id);
        if (!lane || !clip) {
            return null;
        }

        const start = clip.start + clip.length;
        if (!this.isFree(lane.id, start, clip.length)) {
            return null;
        }
        const copy: SongClip = { ...clip, id: createId(), start };
        lane.clips.push(copy);
        this.sortLane(lane);
        return copy;
    }

    removeClip(id: string): void {
        const lane = this.laneOf(id);
        if (lane) {
            lane.clips.splice(lane.clips.findIndex((clip) => clip.id === id), 1);
        }
    }

    /** Number of clips that play the container. */
    countClips(containerId: string): number {
        return this.clips.filter((clip) => clip.containerId === containerId).length;
    }

    /** Forgets a container everywhere, e.g. after it was deleted: its clips and the automation that drove it or its tracks. */
    removeContainer(containerId: string): void {
        for (const lane of this.lanes) {
            for (let i = lane.clips.length - 1; i >= 0; i--) {
                if (lane.clips[i]!.containerId === containerId) {
                    lane.clips.splice(i, 1);
                }
            }
        }
        this.pruneAutomation((target) => target.kind !== 'master' && target.containerId === containerId);
    }

    /* ---- automation ---- */

    addAutomation(target: AutomationTarget, param: string): SongAutomationLane {
        const lane = createSongLane(target, param);
        this.automation.push(lane);
        return lane;
    }

    /** Points a lane at another value; the curve stays. */
    retargetAutomation(id: string, target: AutomationTarget, param: string): void {
        const lane = this.automation.find((candidate) => candidate.id === id);
        if (lane) {
            lane.target = target;
            lane.param = param;
        }
    }

    removeAutomation(id: string): void {
        const index = this.automation.findIndex((lane) => lane.id === id);
        if (index !== -1) {
            this.automation.splice(index, 1);
        }
    }

    /** Forgets the automation of a deleted track. */
    removeTrack(trackId: string): void {
        this.pruneAutomation((target) => target.kind === 'track' && target.trackId === trackId);
    }

    private pruneAutomation(gone: (target: AutomationTarget) => boolean): void {
        for (let i = this.automation.length - 1; i >= 0; i--) {
            if (gone(this.automation[i]!.target)) {
                this.automation.splice(i, 1);
            }
        }
    }

    private sortLane(lane: SongLane): void {
        lane.clips.sort((a, b) => a.start - b.start);
    }
}
