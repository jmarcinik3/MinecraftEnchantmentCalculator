// Keeps a copy of the site so it opens without a connection (e.g. on a phone next to
// the game). Network first: online, every request goes to the server as usual and the
// answer is saved; offline, the saved copy is used. So the site is never older than
// the last visit online.
//
// It sits next to index.html because a service worker only covers its own folder.
// Deploy stamps VERSION with the commit (.github/stamp-version.sh), so the files below
// get the same ?v= addresses the page asks for, and each release starts a fresh cache.

const VERSION = "dev";
const CACHE = "enchantment-calculator-" + VERSION;

// Loaded up front, so the site works offline after one visit. Images are saved as the
// page shows them.
const FILES = [
    "css/Style.css", "js/Logic.js", "js/Text.js", "js/Calculator.js", "js/Engine.js",
    "js/App.js", "js/Store.js", "js/Dom.js", "js/Motion.js", "js/Wanted.js", "js/Books.js", "js/Ranking.js", "js/Options.js",
    "js/Results.js", "js/Calc.js", "js/Link.js", "js/Tips.js", "js/Graph.js", "js/Languages.js", "js/Feedback.js",
    "json/metadata.json", "json/mods/fancy_enchantments.json", "json/mods/spellbound.json", "json/text/en_us.json", "json/text/es_es.json"
].map(file => (VERSION === "dev" ? file : file + "?v=" + VERSION));
const PAGES = ["./", "index.html", "manifest.webmanifest", "font/minecraft.woff"];

self.addEventListener("install", event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([...PAGES, ...FILES])).then(() => self.skipWaiting()));
});

// Older releases' copies are no longer needed.
self.addEventListener("activate", event => {
    event.waitUntil(caches.keys()
        .then(names => Promise.all(names.filter(name => name.startsWith("enchantment-calculator-") && name !== CACHE).map(name => caches.delete(name))))
        .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;
    // "no-cache": always check with the server (an unchanged file is a short "not
    // modified" reply), so the browser's own cache cannot hand back an old copy.
    // A page request can't be copied with options, so it is rebuilt from its address.
    const fresh = request.mode === "navigate"
        ? new Request(request.url, { cache: "no-cache", credentials: "same-origin" })
        : new Request(request, { cache: "no-cache" });
    event.respondWith(fetch(fresh)
        .then(response => {
            if (response.ok) {
                const copy = response.clone();
                event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
            }
            return response;
        })
        .catch(async () => {
            const cache = await caches.open(CACHE);
            // The page itself may be asked for with a query (a share link opens with one).
            const saved = await cache.match(request) ||
                (request.mode === "navigate" ? await cache.match("./") : await cache.match(request, { ignoreSearch: true }));
            return saved || Response.error();
        }));
});
