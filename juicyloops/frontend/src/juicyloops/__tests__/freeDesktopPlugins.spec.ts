import { describe, expect, it } from 'vitest';
import { desktopSystem, FREE_DESKTOP_PLUGINS } from '../plugins/freeDesktopPlugins';

describe('free desktop plugins', () => {
    it('lists each plugin once, with an https page, a bridge format and at least one system', () => {
        const names = FREE_DESKTOP_PLUGINS.map((entry) => entry.name);
        expect(new Set(names).size).toBe(names.length);
        const broken = FREE_DESKTOP_PLUGINS.filter(
            (entry) =>
                !entry.url.startsWith('https://') ||
                !entry.formats.length ||
                !entry.formats.every((format) => format === 'VST3' || format === 'CLAP') ||
                !entry.systems.length ||
                entry.description.length <= 10,
        ).map((entry) => entry.name);
        expect(broken).toEqual([]);
        expect(FREE_DESKTOP_PLUGINS.some((entry) => entry.kind === 'instrument')).toBe(true);
        expect(FREE_DESKTOP_PLUGINS.some((entry) => entry.kind === 'effect')).toBe(true);
    });
});

describe('desktopSystem', () => {
    it('reads the bridge’s system name first', () => {
        expect(desktopSystem('windows', 'Macintosh')).toBe('Windows');
        expect(desktopSystem('macos', '')).toBe('macOS');
        expect(desktopSystem('linux', '')).toBe('Linux');
    });

    it('guesses from the browser without a bridge, never taking "darwin" for Windows', () => {
        expect(desktopSystem(undefined, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140')).toBe('Windows');
        expect(desktopSystem(undefined, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe('macOS');
        expect(desktopSystem(undefined, 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140')).toBe('Linux');
        expect(desktopSystem('darwin', '')).toBe('macOS');
        expect(desktopSystem(undefined, 'Mozilla/5.0 (Linux; Android 14) Mobile')).toBeNull();
    });
});
