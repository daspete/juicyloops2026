/**
 * Every keyboard shortcut and mouse gesture of the studio, for the help dialog. Keep it in step with the handlers:
 * the global ones in `JuicyLoops.vue`, the song editor's, the piano roll's, the velocity lane's, the sample browser's,
 * and the knobs and faders.
 *
 * `keys` is a list of alternatives; each alternative is a list of keys pressed together. `Mod` reads Ctrl, or ⌘ on a Mac.
 */
export interface Shortcut {
    keys: readonly (readonly string[])[];
    does: string;
}

export interface ShortcutGroup {
    title: string;
    icon: string;
    /** Where the shortcuts work. */
    where: string;
    items: readonly Shortcut[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
    {
        title: 'Everywhere',
        icon: 'mdi:keyboard-outline',
        where: 'Anywhere in the studio, unless you are typing in a field',
        items: [
            { keys: [['Space']], does: 'Play / stop' },
            { keys: [['R']], does: 'Record (again: stop recording, playback goes on)' },
            { keys: [['Mod', 'Z']], does: 'Undo' },
            { keys: [['Mod', 'Shift', 'Z'], ['Mod', 'Y']], does: 'Redo' },
            { keys: [['Mod', 'S']], does: 'Save' },
            { keys: [['Mod', 'Shift', 'S']], does: 'Save as a new file' },
            { keys: [['Mod', 'O']], does: 'Open a file' },
            { keys: [['Mod', 'E']], does: 'Export as WAV or MP3' },
            { keys: [['?']], does: 'This help' },
        ],
    },
    {
        title: 'Panels',
        icon: 'mdi:view-dashboard-outline',
        where: 'Anywhere in the studio',
        items: [
            { keys: [['B']], does: 'Sample browser (in the song view B picks the paint tool)' },
            { keys: [['D']], does: 'Devices: instrument and effects of the selected channel (song view: erase tool)' },
            { keys: [['M']], does: 'Mixer' },
            { keys: [['I']], does: 'Inspector' },
        ],
    },
    {
        title: 'Knobs and faders',
        icon: 'mdi:knob',
        where: 'With the pointer on a knob or fader, or with it focused',
        items: [
            { keys: [['Drag ↕']], does: 'Turn it (up is more)' },
            { keys: [['Shift', 'Drag ↕']], does: 'Fine steps' },
            { keys: [['Wheel']], does: 'Nudge it' },
            { keys: [['Double-click']], does: 'Back to its default' },
            { keys: [['↑'], ['↓']], does: 'Small step (hold Shift for a big one)' },
            { keys: [['Home'], ['End']], does: 'All the way up / down' },
        ],
    },
    {
        title: 'Steps and velocity',
        icon: 'mdi:chart-bar',
        where: 'In the track view',
        items: [
            { keys: [['Click']], does: 'Switch a step on or off' },
            { keys: [['Drag']], does: 'Paint (or clear) across several steps' },
            { keys: [['Drag a stem']], does: 'Velocity: change that note, relative to where it was' },
            { keys: [['Shift', 'Drag']], does: 'Velocity: fine' },
            { keys: [['Alt', 'Drag']], does: 'Velocity: straight ramp (Line tool)' },
            { keys: [['Double-click a stem']], does: 'Velocity back to 100%' },
            { keys: [['←'], ['→']], does: 'Velocity lane focused: previous / next note' },
            { keys: [['↑'], ['↓']], does: 'Velocity lane focused: ±1% (Shift: ±10%)' },
            { keys: [['Right-click']], does: 'Velocity lane: humanize, randomize, ramps, accents…' },
            { keys: [['Esc']], does: 'Velocity lane: drop the curve handle' },
        ],
    },
    {
        title: 'Piano roll',
        icon: 'mdi:piano',
        where: 'With the piano roll focused (click into it)',
        items: [
            { keys: [['Mod', 'A']], does: 'Select every note' },
            { keys: [['Mod', 'C'], ['Mod', 'X'], ['Mod', 'V']], does: 'Copy / cut / paste (pastes at the playhead while playing)' },
            { keys: [['Mod', 'D']], does: 'Duplicate the selection right after itself' },
            { keys: [['Del'], ['Backspace']], does: 'Delete the selection' },
            { keys: [['←'], ['→']], does: 'Move by a grid step (Shift: a bar)' },
            { keys: [['↑'], ['↓']], does: 'Move by a semitone (Shift: an octave)' },
            { keys: [['Shift', 'Click'], ['Mod', 'Click']], does: 'Add to the selection' },
            { keys: [['Alt', 'Drag']], does: 'Move or resize without the grid' },
            { keys: [['Mod', 'Wheel']], does: 'Zoom the time axis' },
            { keys: [['Right-click']], does: 'Delete a note' },
            { keys: [['Esc']], does: 'Close quantize, or clear the selection' },
        ],
    },
    {
        title: 'Song view',
        icon: 'mdi:view-sequential-outline',
        where: 'In the song arranger (Pro)',
        items: [
            { keys: [['P']], does: 'Draw tool' },
            { keys: [['B']], does: 'Paint tool' },
            { keys: [['D']], does: 'Erase tool' },
            { keys: [['T']], does: 'Mute tool' },
            { keys: [['C']], does: 'Slice tool' },
            { keys: [['E']], does: 'Select tool' },
            { keys: [['Home']], does: 'Back to the start (or the loop start)' },
            { keys: [['Mod', 'A']], does: 'Select every clip' },
            { keys: [['Mod', 'C'], ['Mod', 'X'], ['Mod', 'V']], does: 'Copy / cut / paste clips' },
            { keys: [['Mod', 'D'], ['Mod', 'B']], does: 'Duplicate the selection' },
            { keys: [['Del'], ['Backspace']], does: 'Delete the selection' },
            { keys: [['←'], ['→']], does: 'Move clips by the grid (Shift: a bar)' },
            { keys: [['↑'], ['↓']], does: 'Move clips to the lane above / below' },
            { keys: [['Double-click']], does: 'Open a container or clip to edit its tracks' },
            { keys: [['Shift', 'Drag']], does: 'Clone clips' },
            { keys: [['Mod', 'Drag']], does: 'Select with a frame' },
            { keys: [['Alt', 'Drag']], does: 'Ignore the grid' },
            { keys: [['Mod', 'Wheel']], does: 'Zoom' },
            { keys: [['Right-click']], does: 'Delete / menu' },
            { keys: [['Esc']], does: 'Cancel a drag, clear the selection' },
        ],
    },
    {
        title: 'Sample browser',
        icon: 'mdi:folder-music-outline',
        where: 'With the sample list focused',
        items: [
            { keys: [['↑'], ['↓']], does: 'Previous / next entry' },
            { keys: [['→'], ['←']], does: 'Open / close a folder' },
            { keys: [['Home'], ['End']], does: 'First / last entry' },
            { keys: [['Enter'], ['Space']], does: 'Play a sample, or open a folder' },
            { keys: [['Esc']], does: 'Stop the preview' },
            { keys: [['Shift', 'F10'], ['Menu']], does: 'Add to a track, and more' },
        ],
    },
    {
        title: 'Devices and mixer',
        icon: 'mdi:tune-vertical',
        where: 'In the bottom dock',
        items: [
            { keys: [['Drag a device']], does: 'Move it in the chain' },
            { keys: [['Alt', 'Drag a device']], does: 'Copy it' },
            { keys: [['Right-click a device']], does: 'Presets, copy, duplicate, reset, remove' },
            { keys: [['Double-click the top edge']], does: 'Dock to full height and back' },
            { keys: [['↑'], ['↓']], does: 'Top edge focused: resize the dock' },
        ],
    },
];

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** How a key reads on this machine: `Mod` is ⌘ on a Mac, Ctrl elsewhere; Alt is ⌥ on a Mac. */
export const keyLabel = (key: string): string => {
    if (key === 'Mod') {
        return IS_MAC ? '⌘' : 'Ctrl';
    }
    if (key === 'Alt' && IS_MAC) {
        return '⌥';
    }
    return key;
};
