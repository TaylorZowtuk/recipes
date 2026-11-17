import { CARDS, DATA, PHOTOS } from "./syncEngine";

type Deps = {
  serviceWorker: ServiceWorkerContainer | undefined;
  deleteCache: (name: string) => Promise<unknown>;
  reload: () => void;
  storage: Pick<Storage, "getItem" | "setItem">;
};

const browserDeps = (): Deps => ({
  serviceWorker: globalThis.navigator?.serviceWorker,
  deleteCache: (name) => (typeof caches === "undefined" ? Promise.resolve() : caches.delete(name)),
  reload: () => location.reload(),
  storage: {
    getItem: (key) => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
  },
});

// Resolves once the new worker found by an update has installed, or with none if there isn't one.
function installed(registration: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  const worker = registration.installing;
  if (!worker) return Promise.resolve(registration.waiting);
  return new Promise((resolve) => {
    const changed = () => {
      if (worker.state === "installing") return;
      worker.removeEventListener("statechange", changed);
      resolve(worker.state === "installed" ? worker : null);
    };
    worker.addEventListener("statechange", changed);
  });
}

// The API moved to a schema this build can't read: the new build's service worker takes over at
// once, then the cached data goes and the page reloads into the new build, which fills it again.
// Once per schema version, so a page still served the old build can't reload forever.
export async function reloadForSchema(version: number, deps: Deps = browserDeps()) {
  const key = "plateful.reloadedForSchema";
  try {
    if (deps.storage.getItem(key) === String(version)) return;
    deps.storage.setItem(key, String(version));
  } catch {
    return;
  }
  const registration = await deps.serviceWorker?.getRegistration().catch(() => undefined);
  if (deps.serviceWorker && registration) {
    await registration.update().catch(() => {});
    const waiting = await installed(registration);
    if (waiting) {
      const container = deps.serviceWorker;
      await new Promise((resolve) => {
        container.addEventListener("controllerchange", resolve, { once: true });
        waiting.postMessage({ type: "SKIP_WAITING" });
      });
    }
  }
  await Promise.all([DATA, CARDS, PHOTOS].map((name) => deps.deleteCache(name)));
  deps.reload();
}
