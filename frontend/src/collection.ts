import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Card, Collection, Recipe, Sync } from "./api/client";
import { session } from "./session";
import {
  CARDS,
  type CacheName,
  createSyncEngine,
  DATA,
  NotAvailableOffline,
  NotFound,
  PHOTOS,
  type Store,
} from "./syncEngine";

export { NotFound };

// The browser's Cache API, or a store that keeps nothing where there is none (an insecure origin,
// or tests), so reads always go to the network there.
function browserStore(): Store {
  if (typeof caches === "undefined")
    return {
      match: async () => undefined,
      put: async () => {},
      delete: async () => {},
      keys: async () => [],
    };
  return {
    match: async (cache, path) => (await caches.open(cache)).match(path),
    put: async (cache, path, response) => (await caches.open(cache)).put(path, response),
    delete: async (cache, path) => void (await caches.open(cache)).delete(path),
    keys: async (cache) =>
      (await (await caches.open(cache)).keys()).map((request) => new URL(request.url).pathname),
  };
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

// Installed as an app, or an editor signed in: everything is cached, not only what's opened.
function prefetchesEverything(): boolean {
  const standalone =
    globalThis.matchMedia?.("(display-mode: standalone)").matches ||
    (globalThis.navigator as { standalone?: boolean } | undefined)?.standalone === true;
  return standalone || session.getSnapshot().isEditor;
}

// The API moved to a schema this build can't read: drop the cached data and reload, once per
// schema version, so a page still served the old build can't reload forever.
async function reloadForSchema(sync: Sync) {
  const key = "plateful.reloadedForSchema";
  try {
    if (sessionStorage.getItem(key) === String(sync.schema_version)) return;
    sessionStorage.setItem(key, String(sync.schema_version));
  } catch {
    return;
  }
  const names: CacheName[] = [DATA, CARDS, PHOTOS];
  if (typeof caches !== "undefined") await Promise.all(names.map((name) => caches.delete(name)));
  location.reload();
}

// The app's one sync engine: every screen reads the Collection and recipes through it.
export const engine = createSyncEngine({
  fetch: (path) => fetch(path),
  store: browserStore(),
  full: prefetchesEverything,
  persist: () => void globalThis.navigator?.storage?.persist?.(),
  onSchemaChange: reloadForSchema,
  storage: browserStorage(),
});

// An editor signing in starts the full prefetch.
let wasEditor = session.getSnapshot().isEditor;
session.subscribe(() => {
  const { isEditor } = session.getSnapshot();
  if (isEditor && !wasEditor) engine.poll().then(engine.prefetch, () => {});
  wasEditor = isEditor;
});

/** Starts polling /api/sync on the app's cadence. */
export const startPolling = () => engine.start(window, document);

const recipes = new Map<string, Recipe>();
const recipeKey = (id: string, version: number) => `${id}@${version}`;

// Polls again after this device changes the Collection, so screens switch to the new version
// once it has loaded, keeping the old one on screen meanwhile.
export function forgetCollection() {
  engine.refresh().then(engine.prefetch, () => {});
}

// Loads the Collection this device just changed, so the page shows the newer recipe at once.
// Says whether it loaded; if not, the page still shows the old one.
export async function reloadCollection(): Promise<boolean> {
  return engine
    .refresh()
    .then(engine.collection)
    .then(
      (collection) => {
        void engine.prefetch();
        return collection.collection_version === engine.getSnapshot().sync?.collection_version;
      },
      () => false,
    );
}

const syncOf = () => engine.getSnapshot().sync;

// The last sync poll: undefined until one answers, null when the last one failed.
export function useSync(): Sync | null | undefined {
  return useSyncExternalStore(engine.subscribe, syncOf);
}

// A recipe at its card's version, from memory, the cache or the API.
async function loadRecipe(card: Card): Promise<Recipe> {
  const key = recipeKey(card.id, card.recipe_version);
  const known = recipes.get(key);
  if (known) return known;
  const recipe = await engine.recipe(card);
  recipes.set(key, recipe);
  return recipe;
}

export type Loaded<T> =
  | { state: "loading" }
  // `offline`: offline, and not in the cache.
  | { state: "failed"; notFound: boolean; offline?: boolean; retry: () => void }
  // `newerLoading`: what shows is an older version, kept on screen while the newer one loads.
  | { state: "ready"; value: T; newerLoading?: boolean };

// Runs `load` whenever `key` changes, or on a retry, and reports how it went. `cached` is shown at
// once, with no loading state, when the value is already in memory. With no `load` yet, it waits.
function useLoaded<T>(
  key: string,
  load: (() => Promise<T>) | undefined,
  cached: T | undefined,
): Loaded<T> {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; attempt: number; loaded: Loaded<T> }>();
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `load` fetches.
  useEffect(() => {
    if (!load) return;
    let current = true;
    const settle = (loaded: Loaded<T>) => current && setResult({ key, attempt, loaded });
    load().then(
      (value) => settle({ state: "ready", value }),
      (error) =>
        settle({
          state: "failed",
          notFound: error instanceof NotFound,
          offline: error instanceof NotAvailableOffline,
          retry,
        }),
    );
    return () => {
      current = false;
    };
  }, [key, attempt, retry]);

  if (result?.key === key && result.attempt === attempt) return result.loaded;
  return cached === undefined ? { state: "loading" } : { state: "ready", value: cached };
}

// The Collection. When a poll finds a newer version, a screen showing it switches once that has
// loaded, keeping the old one on screen meanwhile, and still if the load fails.
const collectionOf = () => engine.getSnapshot().collection;
export function useCollection(): Loaded<Collection> {
  const held = useSyncExternalStore(engine.subscribe, collectionOf);
  const loaded = useLoaded("collection", held ? undefined : engine.collection, undefined);
  return held ? { state: "ready", value: held } : loaded;
}

// Keeps a recipe the API just returned, so its page shows it without loading it again.
export function rememberRecipe(recipe: Recipe) {
  recipes.set(recipeKey(recipe.id, recipe.version), recipe);
}

// The newest version of the recipe in memory, if any.
function newestOf(id: string): Recipe | undefined {
  let newest: Recipe | undefined;
  for (const recipe of recipes.values())
    if (recipe.id === id && (!newest || recipe.version > newest.version)) newest = recipe;
  return newest;
}

// Waits while there is no card, so a screen can call it before the Collection has loaded. When
// the card moves on to a version not yet loaded, as after a conflict, the newest version in memory
// stays on screen meanwhile, so the page keeps its state (selected tab, toast) instead of remounting,
// and says so, so the page can hold off writing at that old version.
export function useRecipe(card: Card | undefined): Loaded<Recipe> {
  const key = card ? recipeKey(card.id, card.recipe_version) : "";
  const cached = card && (recipes.get(key) ?? newestOf(card.id));
  const loaded = useLoaded(key, card && (() => loadRecipe(card)), cached);
  const image = card?.preview?.image_id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the card's id and image name what's opened.
  useEffect(() => {
    if (card) engine.open(card).catch(() => {});
  }, [card?.id, image]);
  return loaded.state === "ready" && card && loaded.value.version !== card.recipe_version
    ? { ...loaded, newerLoading: true }
    : loaded;
}
