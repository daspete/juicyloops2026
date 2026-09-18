export interface TickSnapshot {
    isActive: boolean;
    volume: number;
}

export class BaseTick {
    isActive = false;
    /** Velocity in the range 0..1. */
    volume = 1;

    /** Creates a new tick of the same class with the same values. */
    clone(): this {
        const copy = new (this.constructor as new () => this)();
        Object.assign(copy, this);
        return copy;
    }

    serialize(): TickSnapshot {
        return {
            isActive: this.isActive,
            volume: this.volume,
        };
    }
}
