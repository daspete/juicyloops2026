<script setup lang="ts">
/**
 * The living waveform behind the hero. The server draws three quiet SVG lines so the page has
 * its atmosphere before any script runs; once mounted, a canvas takes over: four lines in the
 * track colours, breathing, glowing, leaning toward the pointer and kicking on every beat of the
 * demo grid. Under reduced motion the canvas paints one frame and stops.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useHeroPulse } from '@/composables/useHeroPulse';

const canvas = ref<HTMLCanvasElement | null>(null);
const live = ref(false);

const { energy, decay } = useHeroPulse();

/* Each line: which colour token, base amplitude, cycles across the width, drift speed, and a slow breath. */
const LINES = [
    { token: '--jl-brand', amplitude: 0.16, cycles: 1.6, speed: 0.35, breath: 0.21, width: 2.5 },
    { token: '--jl-synth', amplitude: 0.11, cycles: 2.4, speed: -0.5, breath: 0.33, width: 2 },
    { token: '--jl-mic', amplitude: 0.13, cycles: 1.1, speed: 0.22, breath: 0.17, width: 2 },
    { token: '--jl-sampler', amplitude: 0.08, cycles: 3.2, speed: -0.28, breath: 0.41, width: 1.5 },
];

/* Server side fallback: the same idea as static paths. */
const FALLBACK = [
    { cycles: 2, amplitude: 70, phase: 0 },
    { cycles: 3, amplitude: 45, phase: 1.3 },
    { cycles: 1, amplitude: 90, phase: 2.6 },
].map((wave) => {
    const points: string[] = [];
    for (let x = 0; x <= 1200; x += 10) {
        const t = (x / 1200) * Math.PI * 2 * wave.cycles + wave.phase;
        points.push(`${x},${(200 + Math.sin(t) * wave.amplitude).toFixed(1)}`);
    }
    return `M${points.join(' L')}`;
});

let frame = 0;
let context: CanvasRenderingContext2D | null = null;
let host: HTMLElement | null = null;
let width = 0;
let height = 0;
let scale = 1;
let last = 0;
let visible = true;
let reduced = false;
let colours: string[] = [];
let colourStamp = 0;

/* The pointer, in canvas space, and how strongly it currently pulls (eases in and out). */
const pointer = { x: 0.5, y: 0.5, weight: 0, targetWeight: 0 };

const readColours = () => {
    const style = getComputedStyle(document.documentElement);
    colours = LINES.map((line) => style.getPropertyValue(line.token).trim() || '#a78bfa');
};

const resize = () => {
    if (!canvas.value || !host) {
        return;
    }
    scale = Math.min(window.devicePixelRatio || 1, 2);
    width = host.clientWidth;
    height = host.clientHeight;
    canvas.value.width = Math.round(width * scale);
    canvas.value.height = Math.round(height * scale);
    context?.setTransform(scale, 0, 0, scale, 0, 0);
};

const draw = (time: number) => {
    if (!context) {
        return;
    }
    const seconds = time / 1000;
    const delta = Math.min(0.05, seconds - last || 0.016);
    last = seconds;

    if (time - colourStamp > 500) {
        readColours();
        colourStamp = time;
    }

    pointer.weight += (pointer.targetWeight - pointer.weight) * Math.min(1, delta * 4);
    decay(delta);
    const kick = energy.value;

    const ctx = context;
    ctx.clearRect(0, 0, width, height);
    const dark = document.documentElement.classList.contains('dark');
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const step = Math.max(4, Math.floor(width / 220));
    const px = pointer.x * width;
    const py = pointer.y * height;
    const reach = width * 0.18;

    LINES.forEach((line, index) => {
        const breath = 0.75 + 0.25 * Math.sin(seconds * line.breath * Math.PI * 2 + index);
        const amplitude = height * line.amplitude * breath * (1 + kick * 0.6);
        const base = height * (0.42 + index * 0.06);

        ctx.beginPath();
        for (let x = 0; x <= width + step; x += step) {
            const u = x / width;
            const phase = u * Math.PI * 2 * line.cycles + seconds * line.speed * Math.PI * 2;
            /* Two sines per line keep the shape from looking like a textbook wave. */
            let y = base + Math.sin(phase) * amplitude + Math.sin(phase * 2.3 + index) * amplitude * 0.3;

            /* Near the pointer the line swells and is drawn toward it. */
            const distance = x - px;
            const near = Math.exp(-(distance * distance) / (2 * reach * reach)) * pointer.weight;
            y += (py - y) * near * 0.55 + Math.sin(phase * 4 + seconds * 6) * amplitude * near * 0.8;

            if (x === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        const colour = colours[index];
        /* Glow pass, then the line itself. */
        ctx.strokeStyle = colour;
        ctx.globalAlpha = (dark ? 0.16 : 0.12) + kick * 0.1;
        ctx.lineWidth = line.width * 6;
        ctx.stroke();
        ctx.globalAlpha = (dark ? 0.85 : 0.7) + Math.min(0.15, kick * 0.15);
        ctx.lineWidth = line.width;
        ctx.stroke();
    });

    ctx.globalAlpha = 1;

    if (!reduced && visible) {
        frame = requestAnimationFrame(draw);
    }
};

const start = () => {
    if (reduced) {
        draw(performance.now());
        return;
    }
    cancelAnimationFrame(frame);
    last = performance.now() / 1000;
    frame = requestAnimationFrame(draw);
};

const onMove = (event: PointerEvent) => {
    if (!host) {
        return;
    }
    const rect = host.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width;
    pointer.y = (event.clientY - rect.top) / rect.height;
    pointer.targetWeight = 1;
};

const onLeave = () => {
    pointer.targetWeight = 0;
};

let observer: IntersectionObserver | undefined;
let motion: MediaQueryList | undefined;

const onMotionChange = () => {
    reduced = motion?.matches ?? false;
    start();
};

onMounted(() => {
    if (!canvas.value) {
        return;
    }
    host = canvas.value.parentElement;
    context = canvas.value.getContext('2d');
    if (!context || !host) {
        return;
    }

    motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = motion.matches;
    motion.addEventListener('change', onMotionChange);

    readColours();
    resize();
    live.value = true;
    window.addEventListener('resize', resize);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);

    observer = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (visible) {
            start();
        }
    });
    observer.observe(host);

    start();
});

onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    motion?.removeEventListener('change', onMotionChange);
    window.removeEventListener('resize', resize);
    host?.removeEventListener('pointermove', onMove);
    host?.removeEventListener('pointerleave', onLeave);
});
</script>

<template>
    <canvas ref="canvas" class="mk-hero-canvas" :data-live="live" aria-hidden="true"></canvas>
    <svg v-if="!live" class="mk-hero-wave" viewBox="0 0 2400 400" preserveAspectRatio="none" aria-hidden="true">
        <path v-for="(d, i) in FALLBACK" :key="i" :d="d" />
    </svg>
</template>
