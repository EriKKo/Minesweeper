// Minimal PWA service worker: cache-first for static assets, network-only for anything that can
// carry per-request/personalized data. The placeholder CACHE_NAME below is replaced by
// staticServer.js with the server process's start timestamp before this file is served — every
// deploy is a fresh process, so every deploy gets a fresh cache name, and `activate` below deletes
// any cache left over from a previous version. Dev (DEV_AUTH=1) never serves this file at all — see
// staticServer.js, which serves a small self-unregistering worker instead — so there's no caching
// to fight with locally.
var CACHE_NAME = "msbattle-__SW_VERSION__";

// Static assets (JS/CSS/SVG/PNG — anything with a file extension) never change at their URL within
// one deploy, so once cached there's no reason to hit the network for them again this version.
// Everything else — index.html and every SPA route (no file extension, same rule staticServer.js's
// SPA fallback itself uses), /socket.io/*, /api/*, /auth/* — always goes to the network: index.html
// carries per-request hydration data (today's puzzle, the visitor's own account snapshot, the
// revealed route), so a cached copy would go stale or leak a previous visitor's page into a new tab.
function isCacheable(url) {
	if (url.origin !== self.location.origin) return false;
	if (url.pathname.indexOf("/socket.io/") === 0) return false;
	if (url.pathname.indexOf("/api/") === 0) return false;
	if (url.pathname.indexOf("/auth/") === 0) return false;
	return url.pathname.lastIndexOf(".") > url.pathname.lastIndexOf("/");
}

self.addEventListener("install", function(event) {
	self.skipWaiting();
});

self.addEventListener("activate", function(event) {
	event.waitUntil(
		caches.keys()
			.then(function(names) {
				return Promise.all(names.filter(function(name) { return name !== CACHE_NAME; }).map(function(name) { return caches.delete(name); }));
			})
			.then(function() { return self.clients.claim(); })
	);
});

self.addEventListener("fetch", function(event) {
	if (event.request.method !== "GET") return;
	var url = new URL(event.request.url);
	if (!isCacheable(url)) return;
	event.respondWith(
		caches.match(event.request).then(function(cached) {
			if (cached) return cached;
			return fetch(event.request).then(function(response) {
				if (response.ok) {
					var copy = response.clone();
					caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, copy); });
				}
				return response;
			});
		})
	);
});
