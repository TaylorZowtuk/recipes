import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, Sync } from "./api/client";
import { SCHEMA_VERSION } from "./schemaVersion";
import {
  CARDS,
  type CacheName,
  createSyncEngine,
  DATA,
  NotAvailableOffline,
  PHOTOS,
  type Store,
} from "./syncEngine";

// A synthetic Collection on a fake server: two recipes, each with a Preview Photo whose bytes
// are `photoBytes` long. Like the real API, it redirects a stale bundle or recipe version to the
// current one.
function fakeServer() {
  const server = {
    version: 1,
    schema: SCHEMA_VERSION,
    offline: false,
    photoBytes: 10,
    cards: [A, B],
    requests: [] as string[],
    /** Paths answered with this status instead. */
    status: new Map<string, number>(),
    /** While set, requests for paths starting with `prefix` wait for `until`. */
    hold: undefined as { prefix: string; until: Promise<void> } | undefined,
    async fetch(path: string): Promise<Response> {
      server.requests.push(path);
      if (server.offline) throw new TypeError("Failed to fetch");
      if (server.hold && path.startsWith(server.hold.prefix)) await server.hold.until;
      const status = server.status.get(path);
      if (status) return new Response(null, { status });
      if (path === "/api/sync") {
        const sync: Sync = {
          collection_version: server.version,
          schema_version: server.schema,
          read_only: null,
          weeks: null,
        };
        return Response.json(sync);
      }
      if (path.startsWith("/api/v/collection/")) {
        const current = `/api/v/collection/${server.version}`;
        const bundle = { collection_version: server.version, cards: server.cards };
        return landedAt(current, Response.json(bundle));
      }
      const recipe = path.match(/^\/api\/v\/recipes\/([^/]+)\/(\d+)\/(\d+)$/);
      const found = recipe && server.cards.find((c) => c.id === recipe[1]);
      if (found) {
        const current = `/api/v/recipes/${found.id}/${found.recipe_version}/${recipe?.[3]}`;
        return landedAt(current, Response.json({ id: found.id, version: found.recipe_version }));
      }
      if (path.startsWith("/images/")) return new Response(new Uint8Array(server.photoBytes));
      return new Response(null, { status: 404 });
    },
    // The requests since the last call, then forgets them.
    took() {
      const taken = server.requests;
      server.requests = [];
      return taken;
    },
  };
  return server;
}

// Holds the server's answers to paths starting with `prefix` until the returned function is called.
function held(server: ReturnType<typeof fakeServer>, prefix: string): () => void {
  let release = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.hold = { prefix, until };
  return release;
}

// A response as fetch returns it after following redirects to `path`.
function landedAt(path: string, response: Response): Response {
  return Object.defineProperty(response, "url", { value: `http://localhost${path}` });
}

function card(id: string, recipe_version: number, image_id: string | null): Card {
  return {
    id,
    recipe_version,
    preview: image_id ? { image_id, focal_x: 0.5, focal_y: 0.5 } : null,
  } as Card;
}

const A = card("recipe-a", 1, "photo-a");
const B = card("recipe-b", 1, "photo-b");

function memoryStore(): Store & { paths: (cache: CacheName) => string[]; walks: number } {
  const caches = new Map<CacheName, Map<string, Response>>();
  const cache = (name: CacheName) => {
    const found = caches.get(name) ?? new Map<string, Response>();
    caches.set(name, found);
    return found;
  };
  const paths = (name: CacheName) => [...cache(name).keys()].sort();
  const store = {
    paths,
    /** How many times something listed a cache. */
    walks: 0,
    match: async (name: CacheName, path: string) => cache(name).get(path)?.clone(),
    put: async (name: CacheName, path: string, response: Response) =>
      void cache(name).set(path, response.clone()),
    delete: async (name: CacheName, path: string) => void cache(name).delete(path),
    keys: async (name: CacheName) => {
      store.walks++;
      return paths(name);
    },
  };
  return store;
}

const recipePath = (id: string, version: number) =>
  `/api/v/recipes/${id}/${version}/${SCHEMA_VERSION}`;

// Unless `paced`, the prefetch's gaps between requests pass at once.
function setup({ full = false, photoCap = 1000, paced = false } = {}) {
  const server = fakeServer();
  const store = memoryStore();
  const onSchemaChange = vi.fn(async (_sync: Sync) => true);
  const persist = vi.fn();
  const storage = new Map<string, string>();
  const engine = (mode = { full }) =>
    createSyncEngine({
      fetch: server.fetch,
      store,
      full: () => mode.full,
      persist,
      onSchemaChange,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => void storage.set(key, value),
      },
      photoCap,
      ...(paced ? {} : { sleep: async () => {} }),
    });
  return { server, store, storage, onSchemaChange, persist, engine };
}

describe("reading the Collection and recipes", () => {
  it("fetches the bundle at the polled version and keeps it for the next page load offline", async () => {
    const { server, store, engine } = setup();
    const collection = await engine().collection();
    expect(collection.collection_version).toBe(1);
    expect(store.paths(DATA)).toEqual(["/api/v/collection/1"]);

    server.offline = true;
    const later = await engine().collection();
    expect(later.cards.map((c) => c.id)).toEqual(["recipe-a", "recipe-b"]);
  });

  it("reads an opened recipe from the cache once it has been fetched", async () => {
    const { server, engine } = setup();
    const first = engine();
    await first.collection();
    await first.recipe(A);
    server.took();

    server.offline = true;
    const recipe = await engine().recipe(A);
    expect(recipe).toMatchObject({ id: "recipe-a", version: 1 });
  });

  it("keeps a recipe or bundle the API redirected to its current version under that path", async () => {
    const { server, store, engine } = setup();
    const visitor = engine();
    await visitor.poll();
    server.version = 2;
    server.cards = [card("recipe-a", 2, "photo-a"), B];
    const collection = await visitor.collection();
    const recipe = await visitor.recipe(A);

    expect(collection.collection_version).toBe(2);
    expect(recipe).toMatchObject({ id: "recipe-a", version: 2 });
    expect(store.paths(DATA)).toEqual(["/api/v/collection/2", recipePath("recipe-a", 2)]);
  });

  it("says a recipe or the Collection is not available offline when nothing is cached", async () => {
    const { server, engine } = setup();
    server.offline = true;
    const offline = engine();
    await expect(offline.collection()).rejects.toBeInstanceOf(NotAvailableOffline);
    await expect(offline.recipe(A)).rejects.toBeInstanceOf(NotAvailableOffline);
  });
});

describe("prefetching", () => {
  it("caches only what a visitor opens", async () => {
    const { store, engine, persist } = setup();
    const visitor = engine();
    await visitor.collection();
    await visitor.poll();
    await visitor.prefetch();
    expect(store.paths(DATA)).toEqual(["/api/v/collection/1"]);
    expect(store.paths(CARDS)).toEqual([]);

    await visitor.open(B);
    expect(store.paths(CARDS)).toEqual(["/images/photo-b-card.webp"]);
    expect(store.paths(PHOTOS)).toEqual(["/images/photo-b.webp"]);
    await visitor.recipe(B);
    await visitor.prefetch();
    expect(store.paths(DATA)).toEqual(["/api/v/collection/1", recipePath("recipe-b", 1)]);
    expect(persist).not.toHaveBeenCalled();
  });

  it("polls only /api/sync for a visitor until a screen asks for the Collection", async () => {
    const { server, engine } = setup();
    const visitor = engine();
    await visitor.poll();
    await visitor.settled();
    expect(server.took()).toEqual(["/api/sync"]);
    expect(visitor.getSnapshot().collection).toBeUndefined();
  });

  it("caches the bundle, every recipe and every card-size image when installed or an editor", async () => {
    const { store, engine, persist } = setup({ full: true });
    const installed = engine();
    await installed.poll();
    await installed.prefetch();
    await installed.poll();
    await installed.prefetch();
    expect(store.paths(DATA)).toEqual([
      "/api/v/collection/1",
      recipePath("recipe-a", 1),
      recipePath("recipe-b", 1),
    ]);
    expect(store.paths(CARDS)).toEqual(["/images/photo-a-card.webp", "/images/photo-b-card.webp"]);
    expect(store.paths(PHOTOS)).toEqual([]);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("starts a pass once a screen loads the Collection", async () => {
    const { server, store, engine } = setup();
    const mode = { full: false };
    const device = engine(mode);
    await device.poll();
    mode.full = true;
    await device.prefetch();
    expect(server.took()).toEqual(["/api/sync"]);

    await device.collection();
    await device.settled();
    expect(store.paths(DATA)).toHaveLength(3);
  });

  it("starts the full prefetch when the device becomes full", async () => {
    const { store, engine } = setup();
    const mode = { full: false };
    const device = engine(mode);
    await device.collection();
    mode.full = true;
    await device.prefetch();
    expect(store.paths(DATA)).toHaveLength(3);
  });
});

describe("a failed prefetch request", () => {
  it.each([403, 429, 503])(
    "ends the pass on a %i, and a later pass picks up from there",
    async (status) => {
      const { server, store, engine } = setup({ full: true });
      const installed = engine();
      server.status.set(recipePath("recipe-a", 1), status);
      await installed.poll();
      await installed.settled();
      expect(server.took()).toEqual([
        "/api/sync",
        "/api/v/collection/1",
        recipePath("recipe-a", 1),
      ]);

      server.status.clear();
      await installed.poll();
      await installed.settled();
      expect(store.paths(DATA)).toHaveLength(3);
      expect(store.paths(CARDS)).toHaveLength(2);
    },
  );

  it("ends the pass when the network fails", async () => {
    const { server, engine } = setup();
    const mode = { full: false };
    const device = engine(mode);
    await device.collection();
    await device.settled();
    server.took();
    server.offline = true;
    mode.full = true;
    await device.prefetch();
    expect(server.took()).toEqual([recipePath("recipe-a", 1)]);
  });

  it("asks for a missing image only once a session, and carries on past it", async () => {
    const { server, store, engine } = setup({ full: true });
    const installed = engine();
    server.status.set("/images/photo-a-card.webp", 404);
    await installed.poll();
    await installed.settled();
    await installed.prefetch();
    expect(server.took().filter((path) => path === "/images/photo-a-card.webp")).toHaveLength(1);
    expect(store.paths(CARDS)).toEqual(["/images/photo-b-card.webp"]);
  });
});

describe("a new Collection version", () => {
  it("refetches only the recipes that changed and deletes what it supersedes", async () => {
    const { server, store, engine } = setup({ full: true });
    const installed = engine();
    await installed.poll();
    await installed.settled();
    server.took();

    server.version = 2;
    server.cards = [card("recipe-a", 1, "photo-a"), card("recipe-b", 2, "photo-b2")];
    await installed.poll();
    await installed.settled();

    expect(server.took()).toEqual([
      "/api/sync",
      "/api/v/collection/2",
      recipePath("recipe-b", 2),
      "/images/photo-b2-card.webp",
    ]);
    expect(installed.getSnapshot().collection?.collection_version).toBe(2);
    expect(store.paths(DATA)).toEqual([
      "/api/v/collection/2",
      recipePath("recipe-a", 1),
      recipePath("recipe-b", 2),
    ]);
    expect(store.paths(CARDS)).toEqual(["/images/photo-a-card.webp", "/images/photo-b2-card.webp"]);
  });

  it("refetches a visitor's opened recipe that changed, and nothing they didn't open", async () => {
    const { server, store, engine } = setup();
    const visitor = engine();
    await visitor.collection();
    await visitor.recipe(A);
    server.took();

    server.version = 2;
    server.cards = [card("recipe-a", 2, "photo-a"), card("recipe-b", 2, "photo-b")];
    await visitor.poll();
    await visitor.settled();

    expect(server.took()).toEqual([
      "/api/sync",
      "/api/v/collection/2",
      recipePath("recipe-a", 2),
      "/images/photo-a-card.webp",
    ]);
    expect(store.paths(DATA)).toEqual(["/api/v/collection/2", recipePath("recipe-a", 2)]);
  });

  it("keeps the newer bundle a poll cached while a pass over the older one was running", async () => {
    const { server, store, engine } = setup({ full: true });
    const installed = engine();
    await installed.poll();
    const release = held(server, "/api/v/recipes/");
    const pass = installed.prefetch();

    server.version = 2;
    await installed.poll();
    void installed.prefetch();
    release();
    await pass;

    expect(store.paths(DATA)).toContain("/api/v/collection/2");
    expect(store.paths(DATA)).not.toContain("/api/v/collection/1");
  });

  it("leaves the cache alone on a poll that changes nothing after a pass that finished", async () => {
    const { server, store, engine } = setup({ full: true });
    const installed = engine();
    await installed.poll();
    await installed.settled();
    server.took();
    store.walks = 0;
    await installed.poll();
    await installed.settled();
    expect(server.took()).toEqual(["/api/sync"]);
    expect(store.walks).toBe(0);
  });

  it("puts back the bundle in memory when the cache lost it", async () => {
    const { store, engine } = setup({ full: true });
    const installed = engine();
    await installed.poll();
    await installed.prefetch();
    await store.delete(DATA, "/api/v/collection/1");
    await installed.prefetch();
    expect(store.paths(DATA)).toContain("/api/v/collection/1");
  });

  it("drops deleted recipes, and keeps an old version whose new one couldn't be fetched", async () => {
    const { server, store, engine } = setup({ full: true });
    const installed = engine();
    await installed.poll();
    await installed.prefetch();

    server.version = 2;
    server.cards = [card("recipe-a", 2, "photo-a")];
    await installed.poll();
    server.offline = true;
    await installed.prefetch();

    expect(store.paths(DATA)).toEqual(["/api/v/collection/2", recipePath("recipe-a", 1)]);
    expect(store.paths(CARDS)).toEqual(["/images/photo-a-card.webp"]);
  });
});

describe("a schema change", () => {
  it("calls the hook once and fetches nothing more", async () => {
    const { server, engine, onSchemaChange } = setup({ full: true });
    server.schema = SCHEMA_VERSION + 1;
    const installed = engine();
    await installed.poll();
    await installed.poll();
    expect(onSchemaChange).toHaveBeenCalledTimes(1);
    expect(server.took()).toEqual(["/api/sync", "/api/sync"]);
  });

  it("calls the hook again on the next poll when it didn't reload", async () => {
    const { server, engine, onSchemaChange } = setup({ full: true });
    server.schema = SCHEMA_VERSION + 1;
    onSchemaChange.mockResolvedValue(false);
    const installed = engine();
    await installed.poll();
    await installed.poll();
    expect(onSchemaChange).toHaveBeenCalledTimes(2);
    expect(server.took()).toEqual(["/api/sync", "/api/sync"]);
  });

  it("calls the hook again on the next poll when it failed", async () => {
    const { server, engine, onSchemaChange } = setup({ full: true });
    server.schema = SCHEMA_VERSION + 1;
    onSchemaChange.mockRejectedValueOnce(new Error("cache delete failed"));
    const installed = engine();
    await installed.poll();
    await installed.poll();
    expect(onSchemaChange).toHaveBeenCalledTimes(2);
  });

  it("ignores an API behind this build", async () => {
    const { server, engine, onSchemaChange } = setup({ full: true });
    server.schema = SCHEMA_VERSION - 1;
    const installed = engine();
    await installed.poll();
    expect(onSchemaChange).not.toHaveBeenCalled();
    expect(installed.getSnapshot().collection?.collection_version).toBe(1);
  });
});

describe("full-size photos", () => {
  it("evicts the least recently opened once over the cap, counting a reopen as use", async () => {
    const { store, engine } = setup({ photoCap: 25 });
    const device = engine();
    const [a, b] = [A, B];
    const c = card("recipe-c", 1, "photo-c");
    await device.open(a);
    await device.open(b);
    await device.open(a);
    expect(store.paths(PHOTOS)).toEqual(["/images/photo-a.webp", "/images/photo-b.webp"]);

    await device.open(c);
    expect(store.paths(PHOTOS)).toEqual(["/images/photo-a.webp", "/images/photo-c.webp"]);
  });

  it("keeps the photo just opened even when it alone is over the cap", async () => {
    const { store, engine } = setup({ photoCap: 5 });
    await engine().open(A);
    expect(store.paths(PHOTOS)).toEqual(["/images/photo-a.webp"]);
  });

  it("keeps both photos when two opens overlap", async () => {
    const { server, store, engine } = setup();
    const device = engine();
    const release = held(server, "/images/photo-a.webp");
    const openA = device.open(A);
    const openB = device.open(B);
    release();
    await Promise.all([openA, openB]);
    await device.open(card("recipe-c", 1, "photo-c"));
    expect(store.paths(PHOTOS)).toEqual([
      "/images/photo-a.webp",
      "/images/photo-b.webp",
      "/images/photo-c.webp",
    ]);
  });

  it("trims the cache and the index to each other when they disagree", async () => {
    const { server, store, storage, engine } = setup({ photoCap: 25 });
    const photo = (id: string) => `/images/${id}.webp`;
    // photo-a is cached but not indexed, photo-c indexed but not cached, and photo-b, about to be
    // reopened, cached but not indexed.
    await store.put(PHOTOS, photo("photo-a"), new Response(new Uint8Array(10)));
    await store.put(PHOTOS, photo("photo-b"), new Response(new Uint8Array(10)));
    storage.set("plateful.photos", JSON.stringify([{ path: photo("photo-c"), bytes: 1000 }]));

    const device = engine();
    await device.open(B);
    expect(store.paths(PHOTOS)).toEqual([photo("photo-b")]);
    expect(server.took()).toEqual(["/images/photo-b-card.webp"]);

    // Had photo-c's stale entry counted, photo-b would go to make room.
    await device.open(card("recipe-d", 1, "photo-d"));
    expect(store.paths(PHOTOS)).toEqual([photo("photo-b"), photo("photo-d")]);
  });

  it("does nothing for a recipe without a Preview Photo", async () => {
    const { server, store, engine } = setup();
    await engine().open(card("recipe-c", 1, null));
    expect(server.took()).toEqual([]);
    expect(store.paths(PHOTOS)).toEqual([]);
  });
});

describe("polling", () => {
  const MINUTE = 60_000;
  let win: EventTarget;
  let doc: EventTarget & { hidden: boolean };

  beforeEach(() => {
    vi.useFakeTimers();
    win = new EventTarget();
    doc = Object.assign(new EventTarget(), { hidden: false });
  });
  afterEach(() => vi.useRealTimers());

  function started() {
    const { server, engine } = setup();
    const stop = engine().start(win, doc);
    const polls = () => server.took().filter((path) => path === "/api/sync").length;
    return { polls, stop };
  }

  const fire = (target: EventTarget, type: string) => target.dispatchEvent(new Event(type));

  it("polls at once, then every 60 s", async () => {
    const { polls } = started();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(polls()).toBe(3);
  });

  it("never polls while hidden, and polls again on coming back", async () => {
    const { polls } = started();
    await vi.advanceTimersByTimeAsync(0);
    polls();
    doc.hidden = true;
    fire(doc, "visibilitychange");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    fire(win, "online");
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    doc.hidden = false;
    fire(doc, "visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(1);
  });

  it("polls once when coming back fires both visibilitychange and focus", async () => {
    const { polls } = started();
    await vi.advanceTimersByTimeAsync(10_000);
    polls();
    fire(doc, "visibilitychange");
    await vi.advanceTimersByTimeAsync(100);
    fire(win, "focus");
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(1);
  });

  it("keeps polling when the page is hidden and shown again just after a poll", async () => {
    const { polls } = started();
    await vi.advanceTimersByTimeAsync(1_000);
    polls();
    doc.hidden = true;
    fire(doc, "visibilitychange");
    await vi.advanceTimersByTimeAsync(2_000);
    doc.hidden = false;
    fire(doc, "visibilitychange");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(MINUTE - 3_000 - 1);
    expect(polls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(1);
  });

  it("polls when the network comes back, even just after a poll", async () => {
    const { polls } = started();
    await vi.advanceTimersByTimeAsync(10_000);
    polls();
    fire(win, "focus");
    await vi.advanceTimersByTimeAsync(1_000);
    fire(win, "online");
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(2);
  });

  it("polls when the window regains focus", async () => {
    const { polls } = started();
    await vi.advanceTimersByTimeAsync(10_000);
    polls();
    fire(win, "focus");
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(1);
  });

  it("backs off to every 5 minutes after 5 idle minutes, and an interaction brings back 60 s", async () => {
    const { polls } = started();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(polls()).toBe(6);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(polls()).toBe(0);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(polls()).toBe(1);

    await vi.advanceTimersByTimeAsync(MINUTE);
    fire(win, "pointerdown");
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(polls()).toBe(2);
  });

  it("stops polling once stopped", async () => {
    const { polls, stop } = started();
    await vi.advanceTimersByTimeAsync(0);
    polls();
    stop();
    fire(win, "focus");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(polls()).toBe(0);
  });
});

describe("a paced prefetch", () => {
  let win: EventTarget;
  let doc: EventTarget & { hidden: boolean };

  beforeEach(() => {
    vi.useFakeTimers();
    win = new EventTarget();
    doc = Object.assign(new EventTarget(), { hidden: false });
  });
  afterEach(() => vi.useRealTimers());

  it("fetches missing items about a second apart", async () => {
    const { server, store, engine } = setup({ full: true, paced: true });
    const installed = engine();
    await installed.poll();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.took()).toEqual(["/api/sync", "/api/v/collection/1", recipePath("recipe-a", 1)]);
    await vi.advanceTimersByTimeAsync(999);
    expect(server.took()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.took()).toEqual(["/images/photo-a-card.webp"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.took()).toEqual([recipePath("recipe-b", 1)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.took()).toEqual(["/images/photo-b-card.webp"]);
    await installed.settled();
    expect(store.paths(DATA)).toHaveLength(3);
  });

  it("doesn't wait for items already cached", async () => {
    const { server, store, engine } = setup({ full: true, paced: true });
    await store.put(DATA, recipePath("recipe-a", 1), Response.json({}));
    await store.put(CARDS, "/images/photo-a-card.webp", new Response(new Uint8Array(1)));
    const installed = engine();
    await installed.poll();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.took()).toEqual(["/api/sync", "/api/v/collection/1", recipePath("recipe-b", 1)]);
  });

  it("lets a recipe opened meanwhile fetch at once", async () => {
    const { server, engine } = setup({ full: true, paced: true });
    const installed = engine();
    await installed.poll();
    await vi.advanceTimersByTimeAsync(0);
    server.took();
    await installed.open(B);
    await installed.recipe(card("recipe-c", 1, null)).catch(() => {});
    expect(server.took()).toEqual([
      "/images/photo-b-card.webp",
      "/images/photo-b.webp",
      recipePath("recipe-c", 1),
    ]);
  });

  it("drops the older Collection's items when a newer one arrives mid-pass", async () => {
    const { server, store, engine } = setup({ full: true, paced: true });
    const installed = engine();
    await installed.poll();
    await vi.advanceTimersByTimeAsync(0);
    server.took();

    server.version = 2;
    server.cards = [card("recipe-a", 1, "photo-a"), card("recipe-b", 2, "photo-b2")];
    await installed.poll();
    await vi.advanceTimersByTimeAsync(10_000);
    await installed.settled();

    expect(server.took()).toEqual([
      "/api/sync",
      "/api/v/collection/2",
      "/images/photo-a-card.webp",
      recipePath("recipe-b", 2),
      "/images/photo-b2-card.webp",
    ]);
    expect(store.paths(DATA)).toEqual([
      "/api/v/collection/2",
      recipePath("recipe-a", 1),
      recipePath("recipe-b", 2),
    ]);
  });

  it("sends nothing while the page is hidden, and carries on when it's shown", async () => {
    const { server, store, engine } = setup({ full: true, paced: true });
    const installed = engine();
    installed.start(win, doc);
    await vi.advanceTimersByTimeAsync(0);
    server.took();
    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(server.took()).toEqual([]);

    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(3000);
    await installed.settled();
    expect(store.paths(DATA)).toHaveLength(3);
    expect(store.paths(CARDS)).toHaveLength(2);
  });
});
