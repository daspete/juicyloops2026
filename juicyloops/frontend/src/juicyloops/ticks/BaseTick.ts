export class BaseTick {
    isActive: boolean = false;
    volume: number = 1;

    serialize() {
        return {
            isActive: this.isActive,
            volume: this.volume,
        };
    }
}
