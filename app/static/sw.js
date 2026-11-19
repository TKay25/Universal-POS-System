/* Universal POS service worker.
 *
 * Network-first with a cache fallback: a deployment shows up on the next
 * request, and the app still opens when the connection drops. Tenant data under
 * /api/ is never cached — sales, tickets and customer records stay on the server.
 */

const VERSION = "pos-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL_URLS = [
  "/",
  "/offline",
  "/manifest.webmanifest",
  "/static/css/app.css",
  "/static/js/app.js",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
];

/* Never cached: tenant data stays on the server, and the worker must stay fresh. */
const NEVER_CACHE = ["/api/", "/sw.js"];

/* A stalled request must never hang the app or block an install; both fall
   back to the cache once these windows pass. */
const NETWORK_TIMEOUT = 6000;
const PRECACHE_TIMEOUT = 8000;

async function fetchWithTimeout(request, timeout = NETWORK_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function precache(cache, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRECACHE_TIMEOUT);
  try {
    const response = await fetch(url, { cache: "reload", signal: controller.signal });
    if (response.ok) await cache.put(url, response);
  } catch {
    /* unreachable or slow: the runtime cache fills this in on the next page load */
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL_URLS.map((url) => precache(cache, url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith("pos-") && !keep.has(name))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function isCacheable(request, url) {
  if (request.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  if (NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))) return false;
  return true;
}

async function save(cache, key, response) {
  if (!response || !response.ok || response.type !== "basic") return;
  try {
    await cache.put(key, response.clone());
  } catch {
    /* quota or a partial response: the network copy already served the page */
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetchWithTimeout(request);
    await save(cache, request, response);
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  const { pathname } = new URL(request.url);
  try {
    const response = await fetchWithTimeout(request);
    // Every non-API page renders the same shell, so keep the newest copy on "/".
    if (pathname !== "/offline") await save(cache, "/", response);
    return response;
  } catch {
    return (await cache.match(request))
      || (await cache.match("/"))
      || (await cache.match("/offline"))
      || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (!isCacheable(request, url)) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (url.pathname.startsWith("/static/") || url.pathname === "/manifest.webmanifest") {
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
  }
});
