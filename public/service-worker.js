const CACHE_PREFIX = "voice-map-";
const APP_CACHE = `${CACHE_PREFIX}app-v1`;
const ASSET_CACHE = `${CACHE_PREFIX}assets-v1`;
const APP_SHELL = ["/", "/manifest.webmanifest", "/icons/voice-map.svg", "/icons/voice-map-192.png", "/icons/voice-map-512.png"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		Promise.all([
			caches.open(APP_CACHE),
			caches.open(ASSET_CACHE),
			fetch("/", { cache: "no-cache" }),
		])
			.then(async ([shellCache, assetCache, response]) => {
				if (!response.ok) throw new Error("Could not fetch the app shell for offline use.");
				const html = await response.text();
				const assets = [...html.matchAll(/(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g)]
					.map(([, asset]) => new URL(asset, self.location.origin).href);
				await shellCache.addAll(APP_SHELL);
				if (assets.length > 0) await assetCache.addAll(assets);
				const currentAssets = new Set(assets);
				const oldAssets = await assetCache.keys();
				await Promise.all(oldAssets
					.filter((asset) => !currentAssets.has(asset.url))
					.map((asset) => assetCache.delete(asset)));
			})
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches.keys()
			.then((cacheNames) => Promise.all(
				cacheNames
					.filter((cacheName) => cacheName.startsWith(CACHE_PREFIX)
						&& cacheName !== APP_CACHE
						&& cacheName !== ASSET_CACHE)
					.map((cacheName) => caches.delete(cacheName)),
			))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	const requestUrl = new URL(request.url);
	if (request.method !== "GET" || requestUrl.origin !== self.location.origin) return;

	if (request.mode === "navigate") {
		event.respondWith(
			(async () => {
				try {
					const response = await fetch(request);
					if (response.ok) {
						const cache = await caches.open(APP_CACHE);
						await cache.put("/", response.clone());
					}
					return response;
				} catch {
					return (await caches.match("/")) || Response.error();
				}
			})(),
		);
		return;
	}

	if (requestUrl.pathname.startsWith("/assets/")) {
		event.respondWith(
			(async () => {
				const cache = await caches.open(ASSET_CACHE);
				const cached = await cache.match(request);
				if (cached) return cached;
				const response = await fetch(request);
				if (response.ok) await cache.put(request, response.clone());
				return response;
			})(),
		);
		return;
	}

	if (requestUrl.pathname === "/manifest.webmanifest" || requestUrl.pathname.startsWith("/icons/")) {
		event.respondWith(
			caches.match(request).then((cached) => cached || fetch(request)),
		);
	}
});
