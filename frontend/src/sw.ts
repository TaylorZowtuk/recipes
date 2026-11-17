/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  type PrecacheEntry,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CARDS, DATA, PHOTOS } from "./syncEngine";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (PrecacheEntry | string)[] };

// The build, fonts included, so the app opens and keeps its look offline. A new build installs
// beside the old one and takes over on the next launch, unless the page asks it to now.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});
// The first install controls the page that installed it, so its reads already come through here.
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Every app route opens index.html. The API, recipe images and robots.txt come from the server as
// themselves.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//, /^\/images\//, /^\/robots\.txt$/],
  }),
);

// Versioned reads and images come from the sync engine's caches when it holds them, else from the
// network. Only the engine writes to those caches, so its least-recently-opened limit holds.
const engineCache = (path: string) =>
  path.startsWith("/api/v/")
    ? DATA
    : path.startsWith("/images/")
      ? path.endsWith("-card.webp")
        ? CARDS
        : PHOTOS
      : undefined;
registerRoute(
  ({ url, request }) =>
    url.origin === self.location.origin &&
    request.method === "GET" &&
    engineCache(url.pathname) !== undefined,
  async ({ url, request }) => {
    const cache = await caches.open(engineCache(url.pathname) as string);
    return (await cache.match(url.pathname)) ?? fetch(request);
  },
);
