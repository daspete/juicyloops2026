/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** `false` plays synth tracks with the Tone.js engine instead of the Rust worklet (see `tracks/synthEngine.ts`). */
    readonly PUBLIC_RUST_SYNTH?: string;
}
