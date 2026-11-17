import type { Card, Collection, Recipe, Sync } from "./api/client";
import { cardImageUrl, imageUrl } from "./photo";
import { SCHEMA_VERSION } from "./schemaVersion";

// The phone's copy of the Collection: it polls /api/sync, reads the Collection bundle and recipes
// from the local cache first, fetches and keeps what's missing, and deletes what a newer version
// supersedes. Everything it keeps is immutable, cached under the path it was fetched from.

export const DATA = "plateful-data";
export const CARDS = "plateful-cards";
export const PHOTOS = "plateful-photos";
export type CacheName = typeof DATA | typeof CARDS | typeof PHOTOS;

/** Responses by path, as the browser's Cache API keeps them. */
export type Store = {
  match(cache: CacheName, path: string): Promise<Response | undefined>;
  put(cache: CacheName, path: string, response: Response): Promise<void>;
  delete(cache: CacheName, path: string): Promise<void>;
  keys(cache: CacheName): Promise<string[]>;
};

export type SyncSnapshot = {
  /** The last poll's answer: undefined until one answers, null when the last one failed. */
  sync: Sync | null | undefined;
  /** The Collection in memory, once something has read it. */
  collection: Collection | undefined;
};

export class NotFound extends Error {}
/** Offline, and not in the cache. */
export class NotAvailableOffline extends Error {}

const MINUTE = 60_000;
const MIN_GAP = 5_000;
const IDLE = 5 * MINUTE;
const INTERACTIONS = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart"];
const PHOTO_INDEX = "plateful.photos";

const COLLECTION = "/api/v/collection/";
const RECIPES = "/api/v/recipes/";
const collectionPath = (version: number) => `${COLLECTION}${version}`;
const recipePath = (card: Card) => `${RECIPES}${card.id}/${card.recipe_version}/${SCHEMA_VERSION}`;
const recipeIdOf = (path: string) => path.slice(RECIPES.length).split("/")[0] ?? "";

export function createSyncEngine({
  fetch,
  store,
  full,
  persist,
  onSchemaChange,
  storage,
  photoCap = 200 * 1024 * 1024,
}: {
  fetch: (path: string) => Promise<Response>;
  store: Store;
  /** Whether to prefetch everything: installed, or an editor signed in. */
  full: () => boolean;
  /** Asks the browser to keep the cache, once the first full prefetch starts. */
  persist?: () => void;
  /** Called when the API reports a newer schema than this build's. Resolves to whether the page
   * is reloading; if not, the next poll calls it again. */
  onSchemaChange: (sync: Sync) => Promise<boolean>;
  /** Where the full-size photos' recency and sizes are kept. */
  storage?: Pick<Storage, "getItem" | "setItem">;
  photoCap?: number;
}) {
  let snapshot: SyncSnapshot = { sync: undefined, collection: undefined };
  const listeners = new Set<() => void>();
  const update = (changes: Partial<SyncSnapshot>) => {
    snapshot = { ...snapshot, ...changes };
    for (const listener of listeners) listener();
  };

  let polling: Promise<Sync> | undefined;
  let loading: Promise<Collection> | undefined;
  let prefetching: Promise<void> | undefined;
  let prefetchAgain = false;
  let passFinished = false;
  let schemaChanged = false;
  let persisted = false;
  const missing = new Set<string>();

  async function request(path: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(path);
    } catch {
      throw new NotAvailableOffline(path);
    }
    if (response.status === 404) throw new NotFound(path);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response;
  }

  // Fetches and keeps `path` unless it's cached. A redirect to a newer version is kept under
  // the path it landed on.
  async function keep(cache: CacheName, path: string): Promise<Response> {
    const cached = await store.match(cache, path);
    if (cached) return cached;
    const response = await request(path);
    const landed = response.url ? new URL(response.url).pathname : path;
    await store.put(cache, landed, response.clone());
    return response;
  }

  const read = async <T>(path: string): Promise<T> => (await keep(DATA, path)).json();

  async function newestCachedBundle(): Promise<Collection | undefined> {
    const versions = (await store.keys(DATA))
      .filter((path) => path.startsWith(COLLECTION))
      .map((path) => Number(path.slice(COLLECTION.length)));
    if (versions.length === 0) return undefined;
    return (await store.match(DATA, collectionPath(Math.max(...versions))))?.json();
  }

  async function fetchSync(): Promise<Sync> {
    let sync: Sync;
    try {
      sync = await (await request("/api/sync")).json();
    } catch (error) {
      update({ sync: null });
      throw error;
    }
    update({ sync });
    if (sync.schema_version > SCHEMA_VERSION) {
      if (!schemaChanged) {
        schemaChanged = true;
        onSchemaChange(sync).then(
          (reloading) => {
            schemaChanged = reloading;
          },
          () => {
            schemaChanged = false;
          },
        );
      }
      return sync;
    }
    const held = snapshot.collection;
    if ((held || full()) && held?.collection_version !== sync.collection_version)
      update({ collection: await read<Collection>(collectionPath(sync.collection_version)) });
    if (snapshot.collection && (snapshot.collection !== held || !passFinished)) void prefetch();
    return sync;
  }

  /** Polls /api/sync, loads the new bundle if the Collection moved and one is wanted, and brings
   * the cache in line when the Collection moved or the last pass didn't finish. */
  function poll(): Promise<Sync> {
    polling ??= fetchSync().finally(() => {
      polling = undefined;
    });
    return polling;
  }

  /** A poll that starts after any in flight, so it sees this device's own write. */
  const refresh = () => (polling ?? Promise.resolve()).catch(() => {}).then(poll);

  // Keeps `path` for a prefetch. A 404 is remembered for the session; any other failure throws,
  // ending the pass, which a later one picks up.
  async function prefetchOne(cache: CacheName, path: string) {
    if (missing.has(path)) return;
    try {
      await keep(cache, path);
    } catch (error) {
      if (!(error instanceof NotFound)) throw error;
      missing.add(path);
    }
  }

  // Fetches what should be cached and is missing, the bundle in memory first.
  async function fill(collection: Collection) {
    const everything = full();
    if (everything && !persisted) {
      persisted = true;
      persist?.();
    }
    await prefetchOne(DATA, collectionPath(collection.collection_version));
    const cachedRecipes = (await store.keys(DATA)).filter((path) => path.startsWith(RECIPES));
    const opened = new Set(cachedRecipes.map(recipeIdOf));
    for (const card of collection.cards) {
      if (!everything && !opened.has(card.id)) continue;
      await prefetchOne(DATA, recipePath(card));
      if (card.preview) await prefetchOne(CARDS, cardImageUrl(card.preview.image_id));
    }
  }

  // Fills the cache, then deletes what the bundle supersedes: other bundle versions, recipes at an
  // old version once the current one is cached, recipes no longer in the Collection and card-size
  // images no card shows.
  async function tidy() {
    const collection = snapshot.collection;
    if (!collection) return;
    passFinished = await fill(collection).then(
      () => true,
      () => false,
    );

    // A newer Collection arrived meanwhile: the pass queued for it does the deletes.
    if (snapshot.collection !== collection) return;
    const cards = new Map(collection.cards.map((card) => [card.id, card]));
    const data = await store.keys(DATA);
    const cached = new Set(data);
    for (const path of data) {
      const card = path.startsWith(RECIPES) && cards.get(recipeIdOf(path));
      const superseded = path.startsWith(COLLECTION)
        ? path !== collectionPath(collection.collection_version)
        : path.startsWith(RECIPES) &&
          (!card || (path !== recipePath(card) && cached.has(recipePath(card))));
      if (superseded) await store.delete(DATA, path);
    }
    const shown = new Set(
      collection.cards.flatMap((card) =>
        card.preview ? [cardImageUrl(card.preview.image_id)] : [],
      ),
    );
    for (const path of await store.keys(CARDS))
      if (!shown.has(path)) await store.delete(CARDS, path);
  }

  /** Brings the cache in line with the Collection in memory, as when the device starts
   * prefetching everything. One runs at a time. */
  function prefetch(): Promise<void> {
    if (prefetching) {
      prefetchAgain = true;
      return prefetching;
    }
    prefetching = (async () => {
      do {
        prefetchAgain = false;
        await tidy().catch(() => {});
      } while (prefetchAgain);
    })().finally(() => {
      prefetching = undefined;
    });
    return prefetching;
  }

  // The bundle at the polled version. When there's no poll or no bundle to be had, the newest
  // cached one stands in, so a phone offline or with the API down still shows the Collection.
  async function loadCollection(): Promise<Collection> {
    try {
      const sync = snapshot.sync ?? (await poll());
      const collection =
        snapshot.collection ?? (await read<Collection>(collectionPath(sync.collection_version)));
      update({ collection });
      return collection;
    } catch (error) {
      const cached = await newestCachedBundle();
      if (!cached) throw error;
      update({ collection: cached });
      return cached;
    }
  }

  function collection(): Promise<Collection> {
    if (snapshot.collection) return Promise.resolve(snapshot.collection);
    loading ??= loadCollection().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  type PhotoEntry = { path: string; bytes: number };
  function readPhotoIndex(): PhotoEntry[] {
    try {
      const value: unknown = JSON.parse(storage?.getItem(PHOTO_INDEX) ?? "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }
  function writePhotoIndex(index: PhotoEntry[]) {
    try {
      storage?.setItem(PHOTO_INDEX, JSON.stringify(index));
    } catch {
      // Without the index, the next open starts the LRU afresh from the cache.
    }
  }

  // Caches a full-size photo and marks it the most recently opened, then evicts the least
  // recently opened until the photos fit the cap. The index, oldest first, and the cache are
  // trimmed to each other, so neither holds what the other lost. Opens run one at a time.
  let opening: Promise<void> = Promise.resolve();
  function openPhoto(path: string): Promise<void> {
    const next = opening.then(() => cachePhoto(path));
    opening = next.catch(() => {});
    return next;
  }

  async function cachePhoto(path: string) {
    const cached = new Set(await store.keys(PHOTOS));
    const known = readPhotoIndex().filter((entry) => cached.has(entry.path));
    const previous = known.find((entry) => entry.path === path);
    const index = known.filter((entry) => entry.path !== path);
    const indexed = new Set(index.map((entry) => entry.path));
    for (const stray of cached)
      if (stray !== path && !indexed.has(stray)) await store.delete(PHOTOS, stray);
    const bytes = previous?.bytes ?? (await (await keep(PHOTOS, path)).blob()).size;
    index.push({ path, bytes });
    let total = index.reduce((sum, entry) => sum + entry.bytes, 0);
    while (total > photoCap && index.length > 1) {
      const oldest = index.shift() as PhotoEntry;
      await store.delete(PHOTOS, oldest.path);
      total -= oldest.bytes;
    }
    writePhotoIndex(index);
  }

  /** Polls now and on the cadence, and returns a function that stops it. */
  function start(win: EventTarget, doc: EventTarget & { hidden: boolean }): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastPoll = Number.NEGATIVE_INFINITY;
    let lastInteraction = Date.now();
    let backedOff = false;

    // Every 60 s while visible, every 5 minutes after 5 minutes without an interaction, and
    // never while hidden.
    const schedule = () => {
      clearTimeout(timer);
      if (doc.hidden) return;
      backedOff = Date.now() - lastInteraction >= IDLE;
      const wait = lastPoll + (backedOff ? IDLE : MINUTE) - Date.now();
      timer = setTimeout(tick, Math.max(0, wait));
    };
    // Coming back fires visibilitychange and focus together, so a tick just after a poll skips.
    const tick = () => {
      if (doc.hidden) return schedule();
      if (Date.now() - lastPoll < MIN_GAP) return;
      lastPoll = Date.now();
      poll().catch(() => {});
      schedule();
    };
    const interacted = () => {
      lastInteraction = Date.now();
      if (backedOff) schedule();
    };
    const visibility = () => (doc.hidden ? schedule() : tick());

    doc.addEventListener("visibilitychange", visibility);
    win.addEventListener("focus", tick);
    win.addEventListener("online", tick);
    for (const type of INTERACTIONS)
      win.addEventListener(type, interacted, { capture: true, passive: true });
    tick();
    return () => {
      clearTimeout(timer);
      doc.removeEventListener("visibilitychange", visibility);
      win.removeEventListener("focus", tick);
      win.removeEventListener("online", tick);
      for (const type of INTERACTIONS) win.removeEventListener(type, interacted, { capture: true });
    };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    poll,
    refresh,
    prefetch,
    /** Resolves once no prefetch pass is running. */
    settled: () => prefetching ?? Promise.resolve(),
    collection,
    /** A recipe at its card's version, from the cache or else fetched and kept. */
    recipe: (card: Card): Promise<Recipe> => read<Recipe>(recipePath(card)),
    /** A recipe was opened: keeps its card-size image, and its full-size one in the LRU. */
    async open(card: Card) {
      if (!card.preview) return;
      await keep(CARDS, cardImageUrl(card.preview.image_id));
      await openPhoto(imageUrl(card.preview.image_id));
    },
    start,
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
