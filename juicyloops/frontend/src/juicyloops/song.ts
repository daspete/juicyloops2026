import { createId } from './audio';
import { createSongLane, type AutomationTarget, type SongAutomationLane } from './automation';

/** The arrangement as history keeps it: plain copies of the lanes, clips and automation. */
export interface SongState {
    lanes: SongLane[];
    automation: SongAutomationLane[];
}

/** Steps per bar; the song grid snaps to beats of `SONG_SNAP` steps unless the editor picks another grid. */
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
    /** A muted clip stays in place but is silent. Optional, so songs saved before it existed still load. */
    isMuted?: boolean;
}

/** A clip to lay down: where, what, and optionally where inside its patterns it begins and whether it is muted. */
export interface ClipSpec {
    laneId: string;
    containerId: string;
    start: number;
    length: number;
    offset?: number;
    isMuted?: boolean;
}

/** A horizontal lane of clips, like a track in a DAW. Clips on one lane never overlap. */
export interface SongLane {
    readonly id: string;
    name: string;
    isMuted: boolean;
    /** While any lane is soloed, only soloed lanes play. Optional for songs saved before solo existed. */
    isSolo?: boolean;
    readonly clips: SongClip[];
}

/** Snaps a step to a grid of `grid` steps (a beat unless told otherwise). */
export const snapStep = (step: number, grid = SONG_SNAP): number => Math.max(0, Math.round(step / grid) * grid);

const createLane = (name: string, id = createId()): SongLane => ({ id, name, isMuted: false, isSolo: false, clips: [] });

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

    /**
     * The editing grid in steps: where clips land, how they resize and where they split. An editor setting,
     * not part of the song, so history and files leave it alone.
     */
    grid = SONG_SNAP;

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
     * Muted lanes and clips stay silent, soloed lanes silence every other lane,
     * and a container placed on several lanes at once plays once.
     */
    playingAt(step: number): Map<string, number> {
        const result = new Map<string, number>();
        const hasSolo = this.lanes.some((lane) => lane.isSolo);
        for (const lane of this.lanes) {
            if (hasSolo ? !lane.isSolo : lane.isMuted) {
                continue;
            }
            for (const clip of lane.clips) {
                if (!clip.isMuted && step >= clip.start && step < clip.start + clip.length && !result.has(clip.containerId)) {
                    result.set(clip.containerId, step - clip.start + clip.offset);
                }
            }
        }
        return result;
    }

    /* ---- lanes ---- */

    /** Adds a lane at the end, or at `index`. */
    addLane(name = `Lane ${this.lanes.length + 1}`, index = this.lanes.length): SongLane {
        const lane = createLane(name);
        this.lanes.splice(Math.min(Math.max(0, index), this.lanes.length), 0, lane);
        return lane;
    }

    /** Removes every clip from a lane, the lane itself stays. */
    clearLane(id: string): void {
        this.getLane(id)?.clips.splice(0);
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

    /** Whether a clip of `length` steps starting at `start` would be free of other clips on the lane (`ignore` excluded). */
    isFree(laneId: string, start: number, length: number, ignore?: string | ReadonlySet<string>): boolean {
        const lane = this.getLane(laneId);
        const ignored = (id: string) => (typeof ignore === 'string' ? id === ignore : !!ignore?.has(id));
        return !!lane && start >= 0 && lane.clips.every((clip) => ignored(clip.id) || clip.start + clip.length <= start || clip.start >= start + length);
    }

    /** Places a container on a lane. Returns null when the spot is taken. */
    addClip(laneId: string, containerId: string, start: number, length: number): SongClip | null {
        const lane = this.getLane(laneId);
        const snapped = snapStep(start, this.grid);
        const size = Math.max(this.grid, snapStep(length, this.grid));
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
        const snapped = snapStep(start, this.grid);
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
        clip.length = Math.min(limit - clip.start, Math.max(this.grid, snapStep(end, this.grid) - clip.start));
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
        const snapped = Math.min(end - Math.min(this.grid, clip.length), Math.max(previous ? previous.start + previous.length : 0, snapStep(start, this.grid)));
        clip.offset += snapped - clip.start;
        clip.start = snapped;
        clip.length = end - snapped;
        this.sortLane(lane);
    }

    /** Cuts a clip in two at a step. Nothing happens on the clip's edges. Returns the new right half. */
    splitClip(id: string, at: number): SongClip | null {
        const lane = this.laneOf(id);
        const clip = this.getClip(id);
        const cut = snapStep(at, this.grid);
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

    removeClips(ids: Iterable<string>): void {
        for (const id of ids) {
            this.removeClip(id);
        }
    }

    /* ---- several clips at once ---- */

    /**
     * Where clips would go when shifted by `delta` steps and `laneDelta` lanes, or null when one of them would leave
     * the timeline or the lanes. Relative positions stay, so clips that did not overlap before do not overlap after.
     */
    private shifted(ids: readonly string[], delta: number, laneDelta: number): { clip: SongClip; spec: ClipSpec }[] | null {
        const specs: { clip: SongClip; spec: ClipSpec }[] = [];
        for (const id of ids) {
            const clip = this.getClip(id);
            const lane = this.laneOf(id);
            const target = lane ? this.lanes[this.lanes.indexOf(lane) + laneDelta] : undefined;
            if (!clip || !target || clip.start + delta < 0) {
                return null;
            }
            specs.push({ clip, spec: { laneId: target.id, containerId: clip.containerId, start: clip.start + delta, length: clip.length, offset: clip.offset, isMuted: clip.isMuted } });
        }
        return specs;
    }

    /** Whether clips can move together by `delta` steps and `laneDelta` lanes without landing on others. */
    canMoveClips(ids: readonly string[], delta: number, laneDelta: number): boolean {
        const moving = new Set(ids);
        const specs = this.shifted(ids, delta, laneDelta);
        return !!specs && specs.every(({ spec }) => this.isFree(spec.laneId, spec.start, spec.length, moving));
    }

    /** Moves clips together, keeping their spacing. All or nothing: refused when one of them would not fit. */
    moveClips(ids: readonly string[], delta: number, laneDelta: number): boolean {
        const specs = this.shifted(ids, delta, laneDelta);
        if (!specs || !this.canMoveClips(ids, delta, laneDelta)) {
            return false;
        }
        for (const { clip, spec } of specs) {
            const from = this.laneOf(clip.id)!;
            const to = this.getLane(spec.laneId)!;
            if (from !== to) {
                from.clips.splice(from.clips.indexOf(clip), 1);
                to.clips.push(clip);
            }
            clip.start = spec.start;
        }
        this.lanes.forEach((lane) => this.sortLane(lane));
        return true;
    }

    /** Whether copies of clips shifted by `delta` steps and `laneDelta` lanes would all fit. */
    canCopyClips(ids: readonly string[], delta: number, laneDelta: number): boolean {
        const specs = this.shifted(ids, delta, laneDelta);
        return !!specs && specs.every(({ spec }) => this.isFree(spec.laneId, spec.start, spec.length));
    }

    /** Copies clips, shifted by `delta` steps and `laneDelta` lanes. Returns the copies, or null when they do not all fit. */
    copyClips(ids: readonly string[], delta: number, laneDelta: number): SongClip[] | null {
        const specs = this.shifted(ids, delta, laneDelta);
        return specs ? this.placeClips(specs.map(({ spec }) => spec)) : null;
    }

    /** Copies clips right behind the stretch of time they cover, like Ctrl+B in a DAW. */
    duplicateClips(ids: readonly string[]): SongClip[] | null {
        const clips = ids.map((id) => this.getClip(id)).filter((clip): clip is SongClip => !!clip);
        if (!clips.length) {
            return null;
        }
        const start = Math.min(...clips.map((clip) => clip.start));
        const end = Math.max(...clips.map((clip) => clip.start + clip.length));
        return this.copyClips(ids, end - start, 0);
    }

    /**
     * Lays down several clips at once, exactly where they are asked for (no snapping). All or nothing:
     * when one of them lands on an existing clip, nothing is placed and the result is null.
     */
    placeClips(specs: readonly ClipSpec[]): SongClip[] | null {
        const fits = specs.every(
            (spec, index) =>
                spec.length > 0 &&
                this.isFree(spec.laneId, spec.start, spec.length) &&
                specs.every((other, otherIndex) => otherIndex === index || other.laneId !== spec.laneId || other.start + other.length <= spec.start || other.start >= spec.start + spec.length),
        );
        if (!fits) {
            return null;
        }
        const placed = specs.map((spec) => {
            const clip: SongClip = { id: createId(), containerId: spec.containerId, start: spec.start, length: spec.length, offset: spec.offset ?? 0 };
            if (spec.isMuted) {
                clip.isMuted = true;
            }
            this.getLane(spec.laneId)!.clips.push(clip);
            return clip;
        });
        this.lanes.forEach((lane) => this.sortLane(lane));
        return placed;
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

    /* ---- history ---- */

    capture(): SongState {
        return {
            lanes: this.lanes.map((lane) => ({ ...lane, clips: lane.clips.map((clip) => ({ ...clip })) })),
            automation: this.automation.map((lane) => ({ ...lane, target: { ...lane.target }, points: lane.points.map((point) => ({ ...point })) })),
        };
    }

    /** Takes a captured state back. Lanes keep their objects where they still exist, so nothing jumps. */
    restore(state: SongState): void {
        const lanes = state.lanes.map((laneState) => {
            const lane = this.getLane(laneState.id) ?? createLane(laneState.name, laneState.id);
            lane.name = laneState.name;
            lane.isMuted = laneState.isMuted;
            lane.isSolo = laneState.isSolo ?? false;
            lane.clips.splice(0, lane.clips.length, ...laneState.clips.map((clip) => ({ ...clip })));
            return lane;
        });
        this.lanes.splice(0, this.lanes.length, ...lanes);

        const automation = state.automation.map((laneState) => {
            const lane = this.automation.find((candidate) => candidate.id === laneState.id) ?? createSongLane(laneState.target, laneState.param, laneState.id);
            lane.target = { ...laneState.target };
            lane.param = laneState.param;
            lane.points.splice(0, lane.points.length, ...laneState.points.map((point) => ({ ...point })));
            return lane;
        });
        this.automation.splice(0, this.automation.length, ...automation);
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
