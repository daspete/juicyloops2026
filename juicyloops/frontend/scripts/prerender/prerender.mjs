/**
 * Prerenders the marketing routes into static HTML.
 *
 * Runs after `vite build` (client) and `vite build --ssr` (server bundle). Each route's markup is
 * written into the built index.html at the route's path (`/` -> dist/index.html,
 * `/imprint` -> dist/imprint/index.html) so nginx serves finished pages and the browser hydrates them.
 * The server bundle is deleted afterwards; it is a build tool, not a deploy artifact.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const serverDir = join(dist, 'server');

const escapeAttribute = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const setMeta = (html, selector, value) =>
    html.replace(new RegExp(`(<meta ${selector} content=")[^"]*(")`), `$1${escapeAttribute(value)}$2`);

const template = await readFile(join(dist, 'index.html'), 'utf8');
if (!template.includes('<!--app-html-->')) {
    throw new Error('dist/index.html has no <!--app-html--> placeholder; is the build current?');
}

const { render, prerenderPaths } = await import(pathToFileURL(join(serverDir, 'entry-server.js')).href);

for (const path of prerenderPaths()) {
    const page = await render(path);
    let html = template
        .replace('<!--app-html-->', page.html)
        .replace(/<title>[^<]*<\/title>/, `<title>${page.title.replace(/</g, '&lt;')}</title>`)
        .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1https://juicyloops.daspete.at${path === '/' ? '/' : `${path}/`}$2`);
    html = setMeta(html, 'property="og:title"', page.title);
    html = setMeta(html, 'name="description"', page.description);
    html = setMeta(html, 'property="og:description"', page.description);

    /* nginx resolves `/imprint` through `$uri/` to imprint/index.html; hosts that look up `imprint.html` get the flat copy. */
    const files = path === '/' ? [join(dist, 'index.html')] : [join(dist, path.slice(1), 'index.html'), join(dist, `${path.slice(1)}.html`)];
    for (const file of files) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, html);
    }
    console.log(`prerendered ${path} -> ${files.map((file) => file.replace(root + '/', '')).join(', ')}`);
}

/*
 * The studio is client only. It gets its own empty shell at /app/index.html so a direct visit to
 * /app or /app/song never flashes the home page before the app takes over (nginx falls back to it).
 */
let shell = template.replace('<!--app-html-->', '').replace(/<title>[^<]*<\/title>/, '<title>Juicy Loops Studio</title>');
shell = setMeta(shell, 'property="og:title"', 'Juicy Loops Studio');
shell = shell.replace(/(<meta property="og:url" content=")[^"]*(")/, '$1https://juicyloops.daspete.at/app$2');
await mkdir(join(dist, 'app'), { recursive: true });
await writeFile(join(dist, 'app', 'index.html'), shell);
await writeFile(join(dist, 'app.html'), shell);
console.log('wrote studio shell -> dist/app/index.html, dist/app.html');

await rm(serverDir, { recursive: true, force: true });
