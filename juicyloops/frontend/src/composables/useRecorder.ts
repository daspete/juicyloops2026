import { toNormalized, type AutomationCurve, type AutomationPoint, type AutomationTarget } from '@/juicyloops/automation';
import { Metronome, type ClickContext } from '@/juicyloops/metronome';
import { ControllerThinner, LaneWriter, SongReplacePass, TakePoints, clearLaneStep, songLaneFor, type LaneWrap } from '@/juicyloops/midi/laneRecord';
import { controllerValue, mappingsFor, paramKey } from '@/juicyloops/midi/mappings';
import { midiNoteName } from '@/juicyloops/midi/messages';
import { clampOffset, readRecordSettings, writeRecordSettings, type RecordSettings } from '@/juicyloops/midi/recordSettings';
import { heardTime, patternPosition, songPosition, songWrap, transportStepAt, type ClockReading, type PlayState, type TakeStart, type TransportClock } from '@/juicyloops/midi/recordTiming';
import type { MidiRouterEvent } from '@/juicyloops/midi/router';
import { notesToReplace, ReplacePass, Take } from '@/juicyloops/midi/take';
import { wrapStart } from '@/juicyloops/notes/Note';
import { SONG_STEPS_PER_BAR } from '@/juicyloops/song';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { reactive, ref, toRaw, watch } from 'vue';
import { useHistory } from './useHistory';
import { useJuicyLoops } from './useJuicyLoops';
import { useMidi } from './useMidi';

/**
 * Recording what is played on MIDI into the armed tracks (Phase 4 of notes/midi-recording.md). Module level state:
 * there is one transport, so there is one recorder.
 *
 * - `record()` (the Record button, the `R` key) starts a take. Stopped: after a one-bar count-in (when on) the
 *   transport starts and the take begins with it. Playing: the take begins right away (punch in).
 * - Notes are written as they close (`midi/take.ts`), learned controllers aimed at an armed track and the pitch wheel
 *   into that track's step lanes (`midi/laneRecord.ts`); in song mode, learned controllers aimed at a container bus,
 *   the master or a track that is not armed into song automation lanes. When a key went down is mapped to what was
 *   heard then and on to a pattern position or song step by `midi/recordTiming.ts`.
 * - Replace clears, on the first pass of a take, what the armed tracks would play at each step just before it is
 *   scheduled (and the stretch of lanes the take records into, song lanes too); later passes overdub.
 * - Pressing record again punches out (playback goes on); stop ends the take where it was heard.
 * - A take is one undo step (`useHistory().hold`).
 * - The metronome clicks straight into the speakers (`metronome.ts`), never through the master.
 */

export type RecordState = 'off' | 'countin' | 'recording';

const { engine, containers, isPlaying, play, stop, onBeforeStop, mode, song, bpm } = useJuicyLoops();
const midi = useMidi();
const history = useHistory();

const state = ref<RecordState>('off');
/** 1..4 while the count-in clicks, 0 otherwise. */
const countInBeat = ref(0);

const settings = reactive<RecordSettings>(readRecordSettings());
watch(settings, (value) => writeRecordSettings({ ...value, offsetMs: clampOffset(value.offsetMs) }), { deep: true });

/* ---- clocks ---- */

const transport = engine.transport;
const context = transport.context;

type NativeContext = AudioContext & { getOutputTimestamp?: () => AudioTimestamp };
const raw = context.rawContext as unknown as ClickContext & { _nativeAudioContext?: NativeContext; _nativeContext?: NativeContext };
/** The browser's own AudioContext behind Tone's wrapper: the only one with `getOutputTimestamp` and the latency figures. */
const native = (): NativeContext | null => raw._nativeAudioContext ?? raw._nativeContext ?? null;

/** Both clocks read together, for mapping an event's time stamp to what was heard. */
const readClock = (): ClockReading => {
    const n = native();
    const output = n && typeof n.getOutputTimestamp === 'function' ? n.getOutputTimestamp() : null;
    return {
        output,
        currentTime: n ? n.currentTime : raw.currentTime,
        now: performance.now(),
        latency: (n?.baseLatency ?? 0) + (n?.outputLatency ?? 0),
    };
};

/** The transport's own clock knows when it runs; the transport only says whether it runs now. */
const tickClock = (transport as unknown as { _clock?: { getStateAtTime(time: number): string } })._clock;
const transportClock: TransportClock = {
    isPlayingAt: (time) => (tickClock ? tickClock.getStateAtTime(time) === 'started' : transport.state === 'started'),
    stepAt: (time) => transport.getTicksAtTime(time) / (transport.PPQ / 4),
};

const playState = (): PlayState => {
    const arrangement = toRaw(song.value);
    return { mode: engine.sequencer.mode, currentContainerId: engine.currentContainer.id, song: arrangement, songLength: arrangement.length, loop: engine.sequencer.loop };
};

/** A track by id (its reactive proxy, so the views see what the take writes) and its container. */
const findTrack = (id: string): { track: BaseTrack; containerId: string } | undefined => {
    for (const container of containers.value) {
        for (const track of container.tracks) {
            if (track.id === id) {
                return { track, containerId: container.id };
            }
        }
    }
    return undefined;
};

/* ---- the metronome ---- */

let metronome: Metronome | null = null;
const clicks = (): Metronome => (metronome ??= new Metronome(raw));

/* ---- the take ---- */

/**
 * Where a lane's recorded value belongs: pattern position (song step for a song lane), value 0..1, the running step it
 * was played at and, for a song lane, where song positions wrap (the loop region, or the song's end).
 */
interface PointAt {
    position: number;
    value: number;
    step: number;
    wrap?: LaneWrap;
}

interface LaneTake {
    /** The track whose step lane this is, or whose parameter a song lane drives (null: a bus or the master). */
    trackId: string | null;
    key: string;
    lane: AutomationCurve;
    /** A song lane (song mode, controllers not aimed at an armed track): its id; null for a track's step lane. */
    songLaneId: string | null;
    thinner: ControllerThinner<PointAt>;
    /** Writes the points, a gesture at a time, with holds keeping the old curve around each gesture. */
    writer: LaneWriter;
    lastPosition: number | null;
    lastStep: number;
    /** The point written last (raw), which the controller's resting value replaces when its step is full. */
    lastPoint: AutomationPoint | null;
}

interface Session {
    take: Take;
    start: TakeStart;
    replace: boolean;
    /** Replace mode: which steps of each track the first pass has cleared. */
    passes: Map<string, ReplacePass>;
    /** Replace mode, song mode: which song steps the take has cleared (for the song lanes it records). */
    songPass: SongReplacePass | null;
    lanes: Map<string, LaneTake>;
    /** The lane points this take put in: recorded (its own) and holds. */
    points: TakePoints;
    /** Parameter values (0..1) when the take started, for lanes it creates: the curve holds them before the first move. */
    startValues: Map<string, number>;
    /** Reused by the position lookups and the step hook (song mode), so they do not allocate maps. */
    positionMap: Map<string, number>;
    hookMap: Map<string, number>;
}

let session: Session | null = null;
/** The last take that ended, for the checks in `scripts/midi/record.mjs`. */
let lastTake: Take | null = null;
/** Tracks whose sustain pedal is down (kept all the time, so a take that starts under a held pedal knows it). */
const pedals = new Set<string>();
const timers: ReturnType<typeof setTimeout>[] = [];

/** Controller moves further apart than this (steps) start a new gesture, which does not wipe the curve in between. */
const GESTURE_GAP_STEPS = 4;
/** Before the first step after a count-in, a note this close to it (in steps) counts as played on it. */
const COUNT_IN_GRACE_STEPS = 1;
/** The count-in's first click comes this long after the button, so it is never cut. */
const COUNT_IN_LEAD_SECONDS = 0.1;

const laneKey = (trackId: string, key: string): string => `${trackId}|${key}`;
const songLaneKey = (target: AutomationTarget, key: string): string => `song|${paramKey(target, key)}`;

const isOwnOf = (current: Session) => current.points.isOwn;

const positionOf = (current: Session, trackId: string, step: number): number | null => {
    const found = findTrack(trackId);
    return found ? patternPosition(step, found.containerId, found.track.length, playState(), current.positionMap) : null;
};

/** The running step a closing event (note-off, pedal, stop) lands on: never before the take began. */
const closingStep = (current: Session, heard: number): number => (heard < current.start.time ? current.start.step : Math.max(current.start.step, transportClock.stepAt(heard)));

/** What is being heard now, as a running step of the take. */
const stepNow = (current: Session): number => closingStep(current, heardTime(performance.now(), readClock(), settings.offsetMs));

const beginTake = (start: TakeStart): void => {
    const tracks = midi.recordTargets();
    const current: Session = {
        take: undefined as unknown as Take,
        start,
        replace: settings.replace,
        passes: new Map(),
        songPass: settings.replace ? new SongReplacePass() : null,
        lanes: new Map(),
        points: new TakePoints(toRaw),
        startValues: new Map(),
        positionMap: new Map(),
        hookMap: new Map(),
    };
    current.take = new Take({ track: (id) => findTrack(id)?.track, position: (id, step) => positionOf(current, id, step), pedalDown: pedals });
    for (const live of tracks) {
        const found = findTrack(live.id);
        if (!found) {
            continue;
        }
        if (current.replace) {
            current.passes.set(live.id, new ReplacePass(found.track.length));
        }
        const keys = engine.sequencer.midiMappings.filter((mapping) => mapping.target.kind === 'track' && mapping.target.trackId === live.id).map((mapping) => mapping.param);
        for (const key of [...keys, 'bend']) {
            const param = found.track.parameter(key);
            if (param) {
                current.startValues.set(laneKey(live.id, key), toNormalized(param, found.track.getParameter(key)));
            }
        }
    }
    // Song mode: every learned parameter may end up in a song lane (all but those of armed tracks do); a new lane
    // holds the value it had when the take began until the controller first moves. (Read in any mode: the sequencer
    // follows a mode switch a tick later, and a switch ends the take anyway.)
    for (const mapping of engine.sequencer.midiMappings) {
        const owner = engine.sequencer.resolveTarget(mapping.target);
        const param = owner?.parameter(mapping.param);
        if (owner && param) {
            current.startValues.set(songLaneKey(mapping.target, mapping.param), toNormalized(param, owner.getParameter(mapping.param)));
        }
    }
    // Everything before the take is its own undo step; the take becomes one step when it ends.
    history.hold(() => endTake());
    session = current;
};

/** Ends the take where it is heard now (or at `step`): open notes close, lanes play again, history gets one step. */
const endTake = (step?: number): void => {
    const current = session;
    if (!current) {
        return;
    }
    session = null;
    lastTake = current.take;
    current.take.stop(step ?? stepNow(current));
    for (const rec of current.lanes.values()) {
        const full = rec.thinner.isFull;
        const pending = rec.thinner.flush();
        if (pending) {
            // The controller's resting value; in a step that is full already it takes the place of the last point.
            const index = full && rec.lastPoint && Math.floor(rec.lastStep) === Math.floor(pending.step) ? toRaw(rec.lane.points).indexOf(rec.lastPoint) : -1;
            if (index !== -1) {
                rec.lane.points.splice(index, 1);
            }
            writePoint(current, rec, pending);
        }
        // The last gesture ends: the old curve after it goes on as it was.
        rec.writer.finish();
        if (rec.songLaneId) {
            engine.sequencer.releaseSongAutomation(rec.songLaneId);
        }
        if (rec.trackId) {
            findTrack(rec.trackId)?.track.releaseAutomation(rec.key);
        }
    }
    while (timers.length) {
        clearTimeout(timers.pop());
    }
    state.value = 'off';
    countInBeat.value = 0;
    history.release();
};

/* ---- controllers into lanes ---- */

const writePoint = (current: Session, rec: LaneTake, at: PointAt): void => {
    const gesture = rec.lastPosition !== null && at.step - rec.lastStep <= GESTURE_GAP_STEPS ? rec.lastPosition : null;
    const point: AutomationPoint = { step: at.position, value: at.value };
    for (const added of rec.writer.write(point, gesture, at.wrap)) {
        if (Math.floor(added.step) === Math.floor(point.step)) {
            // A hold (or a wrapped region's start) in the recorded point's step counts towards the step's points.
            rec.thinner.reserve();
        }
    }
    rec.lastPoint = point;
    rec.lastPosition = at.position;
    rec.lastStep = at.step;
};

/** The lane a take records a parameter into; made on the first move (flat at the value the take started with). */
const laneTake = (current: Session, found: { track: BaseTrack }, key: string, value: number): LaneTake => {
    const id = laneKey(found.track.id, key);
    const existing = current.lanes.get(id);
    if (existing) {
        return existing;
    }
    const track = found.track;
    // While it records, the lane does not play: the controller is heard, not the old curve.
    track.holdAutomation(key);
    if (!track.automation.laneFor(key)) {
        track.automation.add(key, current.startValues.get(id) ?? value);
    }
    const lane = track.automation.laneFor(key)!;
    const pass = current.passes.get(track.id);
    if (current.replace && pass) {
        // A lane that joins a replace take late loses what the take has passed already.
        for (const step of pass.clearedSteps()) {
            clearLaneStep(lane.points, step, isOwnOf(current));
        }
    }
    const writer = new LaneWriter(lane.points, current.points, (position) => current.passes.get(track.id)?.has(position) ?? false);
    const rec: LaneTake = { trackId: track.id, key, lane, songLaneId: null, thinner: new ControllerThinner<PointAt>(), writer, lastPosition: null, lastStep: Number.NEGATIVE_INFINITY, lastPoint: null };
    current.lanes.set(id, rec);
    return rec;
};

const recordValue = (current: Session, found: { track: BaseTrack; containerId: string }, key: string, value: number, heard: number): void => {
    const step = transportStepAt(heard, transportClock, current.start);
    if (step === null) {
        return;
    }
    const position = patternPosition(step, found.containerId, found.track.length, playState(), current.positionMap);
    if (position === null) {
        return;
    }
    const rec = laneTake(current, found, key, value);
    const at = { position, value, step, wrap: { start: 0, end: found.track.length } };
    if (rec.thinner.offer(step, value, at)) {
        writePoint(current, rec, at);
    }
};

/**
 * The song lane a take records a parameter into (song mode); found or made on the first move. While it records, the
 * lane does not play, nor does a track's own step lane for the parameter, so the controller is heard.
 */
const songLaneTake = (current: Session, target: AutomationTarget, key: string, value: number): LaneTake => {
    const id = songLaneKey(target, key);
    const existing = current.lanes.get(id);
    if (existing) {
        return existing;
    }
    const { lane, start } = songLaneFor(song.value, target, key, current.startValues.get(id) ?? value);
    if (start) {
        current.points.addOwn(start);
    }
    engine.sequencer.holdSongAutomation(lane.id);
    const trackId = target.kind === 'track' ? target.trackId : null;
    if (trackId) {
        findTrack(trackId)?.track.holdAutomation(key);
    }
    if (current.songPass) {
        // A lane that joins a replace take late loses what the take has passed already.
        for (const step of current.songPass.clearedSteps()) {
            clearLaneStep(lane.points, step, isOwnOf(current));
        }
    }
    const writer = new LaneWriter(lane.points, current.points, (position) => current.songPass?.has(position) ?? false);
    const rec: LaneTake = { trackId, key, lane, songLaneId: lane.id, thinner: new ControllerThinner<PointAt>(), writer, lastPosition: null, lastStep: Number.NEGATIVE_INFINITY, lastPoint: null };
    current.lanes.set(id, rec);
    return rec;
};

/** A controller move into a song lane, at the song step heard (clip or no clip: song lanes span the timeline). */
const recordSongValue = (current: Session, target: AutomationTarget, key: string, value: number, heard: number): void => {
    const step = transportStepAt(heard, transportClock, current.start);
    if (step === null) {
        return;
    }
    const play = playState();
    const position = songPosition(step, play);
    if (position === null) {
        return;
    }
    const rec = songLaneTake(current, target, key, value);
    const at = { position, value, step, wrap: songWrap(play) };
    if (rec.thinner.offer(step, value, at)) {
        writePoint(current, rec, at);
    }
};

/**
 * A learned controller is recorded when it turns a parameter of a track the event records into (an armed track, or the
 * selected one when none is armed: `recordTrackIds`): into that track's step lane. In song mode the others (a container
 * bus, the master, a track that is not a record target, also the selected track while other tracks are armed) go into
 * song automation lanes; in loop mode there is no timeline for them, so they are only played.
 */
const recordController = (current: Session, event: MidiRouterEvent, heard: number): void => {
    for (const mapping of mappingsFor(engine.sequencer.midiMappings, event.cc ?? -1, event.channel)) {
        const { target } = mapping;
        if (target.kind === 'track' && event.recordTrackIds.includes(target.trackId)) {
            const found = findTrack(target.trackId);
            const param = found?.track.parameter(mapping.param);
            if (found && param) {
                recordValue(current, found, mapping.param, toNormalized(param, controllerValue(param, event.value ?? 0)), heard);
            }
            continue;
        }
        if (engine.sequencer.mode !== 'song') {
            continue;
        }
        const param = engine.sequencer.resolveTarget(target)?.parameter(mapping.param);
        if (param) {
            recordSongValue(current, target, mapping.param, toNormalized(param, controllerValue(param, event.value ?? 0)), heard);
        }
    }
};

/** The wheel plays on top of the bend knob; the lane records what was heard, knob plus wheel. Synth tracks only. */
const recordBend = (current: Session, event: MidiRouterEvent, heard: number): void => {
    for (const trackId of event.recordTrackIds) {
        const found = findTrack(trackId);
        const param = found?.track.parameter('bend');
        if (found && param) {
            const played = Math.min(1, Math.max(-1, found.track.getParameter('bend') + (event.value ?? 0)));
            recordValue(current, found, 'bend', toNormalized(param, played), heard);
        }
    }
};

/* ---- MIDI events ---- */

const onEvent = (event: MidiRouterEvent): void => {
    if (event.type === 'sustain') {
        for (const id of event.trackIds) {
            if ((event.value ?? 0) >= 64) {
                pedals.add(id);
            } else {
                pedals.delete(id);
            }
        }
    }
    const current = session;
    if (!current) {
        return;
    }
    const heard = heardTime(event.timeStamp, readClock(), settings.offsetMs);
    switch (event.type) {
        case 'noteon':
            if (current.replace) {
                for (const id of event.recordTrackIds) {
                    const found = current.passes.has(id) ? undefined : findTrack(id);
                    if (found) {
                        current.passes.set(id, new ReplacePass(found.track.length));
                    }
                }
            }
            current.take.noteOn(event.id!, midiNoteName(event.note!), event.velocity ?? 1, event.recordTrackIds, transportStepAt(heard, transportClock, current.start));
            return;
        case 'noteoff':
            current.take.noteOff(event.id!, event.recordTrackIds, closingStep(current, heard));
            return;
        case 'sustain':
            current.take.sustain((event.value ?? 0) >= 64, event.recordTrackIds, closingStep(current, heard));
            return;
        case 'allnotesoff':
            current.take.allNotesOff(event.recordTrackIds, closingStep(current, heard));
            return;
        case 'cc':
            recordController(current, event, heard);
            return;
        case 'bend':
            recordBend(current, event, heard);
            return;
    }
};

midi.onMidiEvent(onEvent);

/* ---- the step hook: metronome and replace ---- */

/** Replace: the first time a take plays a step of a track, what that step holds goes, just before it is scheduled. */
const clearStep = (current: Session, containerId: string, patternStep: number): void => {
    for (const [trackId, pass] of current.passes) {
        if (pass.isDone) {
            continue;
        }
        const found = findTrack(trackId);
        if (!found || found.containerId !== containerId) {
            continue;
        }
        const position = Math.floor(wrapStart(patternStep, found.track.length));
        if (!pass.claim(position)) {
            continue;
        }
        const ids = notesToReplace(found.track.notes, position, current.take.noteIds);
        if (ids.length) {
            found.track.removeNotes(ids);
        }
        for (const rec of current.lanes.values()) {
            if (!rec.songLaneId && rec.trackId === trackId) {
                clearLaneStep(rec.lane.points, position, isOwnOf(current));
            }
        }
    }
};

/** Replace, song mode: the first time a take plays a song step, the song lanes it records lose that step. */
const clearSongStep = (current: Session, pass: SongReplacePass, step: number): void => {
    if (!pass.claim(step)) {
        return;
    }
    for (const rec of current.lanes.values()) {
        if (rec.songLaneId) {
            clearLaneStep(rec.lane.points, Math.floor(step), isOwnOf(current));
        }
    }
};

engine.sequencer.setStepHook((step, time) => {
    const current = session;
    if ((settings.metronomeWhilePlaying || (current && settings.metronome)) && step % 4 === 0) {
        clicks().click(time, step % SONG_STEPS_PER_BAR === 0);
    }
    if (current?.replace && current.passes.size) {
        if (engine.sequencer.mode === 'loop') {
            clearStep(current, engine.currentContainer.id, step);
        } else {
            for (const [containerId, patternStep] of toRaw(song.value).playingAt(step, current.hookMap)) {
                clearStep(current, containerId, patternStep);
            }
        }
    }
    if (current?.songPass && engine.sequencer.mode === 'song') {
        clearSongStep(current, current.songPass, step);
    }
});

/* Stop ends the take where it is heard, before the transport forgets where it was; clicks still ahead are silenced. */
onBeforeStop(() => {
    endTake();
    metronome?.cancelAfter(context.currentTime);
});

/* Another view (loop or song) plays something else: the take ends. */
watch(mode, () => endTake(), { flush: 'sync' });

/* ---- the transport side ---- */

/** Whether a take has something to record into: an armed track, or a selected one. */
const canRecord = (): boolean => midi.recordTargets().length > 0;

export type RecordResult = 'started' | 'no-track';

/**
 * Starts a take. Stopped: the count-in (when on) clicks one bar, then the transport starts and the take with it.
 * Playing: the take starts right away, at what is heard now.
 */
const record = (): RecordResult => {
    if (state.value !== 'off') {
        return 'started';
    }
    if (!canRecord()) {
        return 'no-track';
    }
    if (isPlaying.value) {
        const heard = heardTime(performance.now(), readClock(), settings.offsetMs);
        beginTake({ time: heard, step: transportClock.stepAt(heard), grace: 0 });
        state.value = 'recording';
        return 'started';
    }
    const now = context.currentTime;
    let startTime = now + context.lookAhead;
    if (settings.countIn) {
        const beat = 60 / bpm.value;
        const first = now + COUNT_IN_LEAD_SECONDS;
        for (let i = 0; i < 4; i++) {
            clicks().click(first + i * beat, i === 0);
            timers.push(setTimeout(() => (countInBeat.value = i + 1), Math.max(0, (first + i * beat - now) * 1000)));
        }
        startTime = first + 4 * beat;
        state.value = 'countin';
        countInBeat.value = 0;
    } else {
        state.value = 'recording';
    }
    play(startTime);
    const grace = settings.countIn ? (COUNT_IN_GRACE_STEPS * 15) / bpm.value : 0;
    beginTake({ time: startTime, step: transportClock.stepAt(startTime), grace });
    if (settings.countIn) {
        timers.push(
            setTimeout(
                () => {
                    if (session) {
                        state.value = 'recording';
                        countInBeat.value = 0;
                    }
                },
                (startTime - now) * 1000,
            ),
        );
    }
    return 'started';
};

/** Ends the take and keeps playing (punch out). During the count-in nothing has started yet: that stops. */
const punchOut = (): void => {
    if (state.value === 'countin') {
        stop();
        return;
    }
    endTake();
};

/** The Record button and the `R` key. */
const toggle = (): RecordResult => {
    if (state.value === 'off') {
        return record();
    }
    punchOut();
    return 'started';
};

export const useRecorder = () => ({
    state,
    countInBeat,
    settings,
    canRecord,
    record,
    punchOut,
    toggle,
    /** Where the running take began (context time, running step), or null. */
    takeStart: (): TakeStart | null => (session ? { ...session.start } : null),
    /** The last finished take (its notes), for checks. */
    lastTake: () => lastTake,
    /** The metronome, once it clicked (for checks). */
    metronome: () => metronome,
});
