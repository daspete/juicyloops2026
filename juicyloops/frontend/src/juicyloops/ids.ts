/** A new unique id (for tracks, containers, clips, lanes, notes). */
export const createId = (): string =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11);
