const CACHE_NAME = 'juicyloops-shell-v1';
const SHELL_ASSETS = ['/', '/index.html', '/manifest.json', '/juicyloopslogo.svg'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)),
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') {
        return;
    }

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
        return;
    }

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const responseCopy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', responseCopy));
                    return response;
                })
                .catch(async () => {
                    const cachedPage = await caches.match(request);
                    if (cachedPage) {
                        return cachedPage;
                    }
                    return caches.match('/index.html');
                }),
        );
        return;
    }

    const isStaticAsset = ['script', 'style', 'image', 'font'].includes(request.destination)
        || url.pathname.startsWith('/assets/')
        || url.pathname === '/manifest.json';

    if (!isStaticAsset) {
        return;
    }

    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }

            return fetch(request).then((networkResponse) => {
                if (networkResponse.ok) {
                    const responseCopy = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, responseCopy));
                }
                return networkResponse;
            });
        }),
    );
});
