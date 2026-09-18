/**
 * Prerenders the marketing routes into static HTML.
 *
 * Runs after `vite build` (client) and `vite build --ssr` (server bundle). Each route's markup is
 * written into the built index.html at the route's path (`/` -> dist/index.html,
 * `/imprint` -> dist/imprint/index.html) so nginx serves finished pages and the browser hydrates them.
 * Every page also gets its own head: title, description, canonical, social tags, structured data
 * and modulepreload hints for the chunks it will import, so the browser never waits for the entry
 * script to discover them. A sitemap is written next to the pages.
 * The server bundle and the build manifest are deleted afterwards; they are build tools, not deploy artifacts.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ORIGIN = 'https://juicyloops.daspete.at';
const SHARE_IMAGE = `${ORIGIN}/juicyloopsshare.jpg`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const serverDir = join(dist, 'server');

const escapeAttribute = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escapeText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const setMeta = (html, selector, value) =>
    html.replace(new RegExp(`(<meta ${selector} content=")[^"]*(")`, 'g'), `$1${escapeAttribute(value)}$2`);

const setHead = (html, { title, description, url, head = '' }) => {
    let out = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeText(title)}</title>`);
    out = out.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`);
    out = setMeta(out, 'property="og:url"', url);
    out = setMeta(out, 'property="og:title"', title);
    out = setMeta(out, 'name="twitter:title"', title);
    out = setMeta(out, 'name="description"', description);
    out = setMeta(out, 'property="og:description"', description);
    out = setMeta(out, 'name="twitter:description"', description);
    return out.replace('<!--app-head-->', head.trim());
};

const template = await readFile(join(dist, 'index.html'), 'utf8');
for (const placeholder of ['<!--app-html-->', '<!--app-head-->']) {
    if (!template.includes(placeholder)) {
        throw new Error(`dist/index.html has no ${placeholder} placeholder; is the build current?`);
    }
}

/* ---------- preload hints from the manifest ---------- */

const manifestFile = join(dist, '.vite', 'manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
const alreadyLoaded = new Set([entry.file, ...(entry.imports ?? []).map((key) => manifest[key].file), ...(entry.css ?? [])]);

/** Every JS and CSS file the given source modules pull in, minus what the entry loads anyway. */
const collectAssets = (sources) => {
    const js = [];
    const css = [];
    const seen = new Set();
    const visit = (key) => {
        const chunk = manifest[key];
        if (!chunk || seen.has(key)) {
            return;
        }
        seen.add(key);
        if (!alreadyLoaded.has(chunk.file)) {
            js.push(chunk.file);
        }
        for (const file of chunk.css ?? []) {
            if (!alreadyLoaded.has(file) && !css.includes(file)) {
                css.push(file);
            }
        }
        for (const dependency of chunk.imports ?? []) {
            visit(dependency);
        }
    };
    sources.forEach(visit);
    return { js, css };
};

const preloadLinks = ({ js, css }) =>
    [
        ...css.map((file) => `<link rel="stylesheet" crossorigin href="/${file}" />`),
        ...js.map((file) => `<link rel="modulepreload" crossorigin href="/${file}" />`),
    ].join('\n    ');

/* ---------- structured data ---------- */

const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

const organisation = {
    '@type': 'Person',
    name: 'Pete',
    url: 'https://daspete.at',
};

const structuredData = {
    '/': (page) => [
        {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'Juicy Loops',
            url: `${ORIGIN}/`,
            description: page.description,
            inLanguage: 'en',
            publisher: organisation,
        },
        {
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Juicy Loops',
            url: `${ORIGIN}/app`,
            image: SHARE_IMAGE,
            description: page.description,
            applicationCategory: 'MultimediaApplication',
            applicationSubCategory: 'Music production',
            operatingSystem: 'Any',
            browserRequirements: 'Requires a modern browser with Web Audio',
            isAccessibleForFree: true,
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
            featureList: [
                'Step sequencer with synth, sampler and microphone tracks',
                'Piano roll with per note velocity and length',
                'Song arranger with clips and containers',
                'Twelve effects on tracks, containers and the master',
                'Automation of any parameter',
                'Undo and redo, sessions saved as one file',
            ],
            author: organisation,
        },
    ],
    '/imprint': (page) => [
        {
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: page.title,
            url: `${ORIGIN}/imprint/`,
            description: page.description,
            inLanguage: 'en',
            isPartOf: { '@type': 'WebSite', name: 'Juicy Loops', url: `${ORIGIN}/` },
        },
    ],
};

/* ---------- pages ---------- */

const { render, prerenderPaths } = await import(pathToFileURL(join(serverDir, 'entry-server.js')).href);

const sitemap = [];
const now = new Date().toISOString().slice(0, 10);

for (const path of prerenderPaths()) {
    const page = await render(path);
    const url = `${ORIGIN}${path === '/' ? '/' : `${path}/`}`;
    const assets = collectAssets(page.modules ?? []);
    const head = [preloadLinks(assets), ...(structuredData[path]?.(page) ?? []).map(jsonLd)].filter(Boolean).join('\n    ');
    const html = setHead(template.replace('<!--app-html-->', page.html), { title: page.title, description: page.description, url, head });

    /* nginx resolves `/imprint` through `$uri/` to imprint/index.html; hosts that look up `imprint.html` get the flat copy. */
    const files = path === '/' ? [join(dist, 'index.html')] : [join(dist, path.slice(1), 'index.html'), join(dist, `${path.slice(1)}.html`)];
    for (const file of files) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, html);
    }
    sitemap.push({ url, priority: path === '/' ? '1.0' : '0.3', changefreq: path === '/' ? 'weekly' : 'yearly' });
    console.log(`prerendered ${path} -> ${files.map((file) => file.replace(root + '/', '')).join(', ')} (+${assets.js.length} preloads)`);
}

/*
 * The studio is client only. It gets its own empty shell at /app/index.html so a direct visit to
 * /app or /app/song never flashes the home page before the app takes over (nginx falls back to it).
 */
const studioAssets = collectAssets(['src/layouts/MainLayout.vue', 'src/pages/index.vue']);
const shell = setHead(template.replace('<!--app-html-->', ''), {
    title: 'Juicy Loops Studio',
    description: 'The Juicy Loops studio: a step sequencer with synths, samples and your voice, an arranger, effects and automation. Free, in your browser.',
    url: `${ORIGIN}/app`,
    head: preloadLinks(studioAssets),
});
await mkdir(join(dist, 'app'), { recursive: true });
await writeFile(join(dist, 'app', 'index.html'), shell);
await writeFile(join(dist, 'app.html'), shell);
sitemap.push({ url: `${ORIGIN}/app`, priority: '0.8', changefreq: 'monthly' });
console.log(`wrote studio shell -> dist/app/index.html, dist/app.html (+${studioAssets.js.length} preloads)`);

/* ---------- sitemap ---------- */

const sitemapXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...sitemap.map(
        (item) =>
            `  <url><loc>${item.url}</loc><lastmod>${now}</lastmod><changefreq>${item.changefreq}</changefreq><priority>${item.priority}</priority></url>`,
    ),
    '</urlset>',
    '',
].join('\n');
await writeFile(join(dist, 'sitemap.xml'), sitemapXml);
console.log(`wrote sitemap -> dist/sitemap.xml (${sitemap.length} urls)`);

await rm(serverDir, { recursive: true, force: true });
await rm(join(dist, '.vite'), { recursive: true, force: true });
