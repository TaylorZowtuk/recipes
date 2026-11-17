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
// are `photoBytes` long.
function fakeServer() {
  const server = {
    version: 1,
    schema: SCHEMA_VERSION,
    offline: false,
    photoBytes: 10,
    cards: [A, B],
    requests: [] as string[],
    /** While set, recipe requests wait for it. */
    holdRecipes: undefined as Promise<void> | undefined,
    async fetch(path: string): Promise<Response> {
      server.requests.push(path);
      if (server.offline) throw new TypeError("Failed to fetch");
      if (server.holdRecipes && path.startsWith("/api/v/recipes/")) await server.holdRecipes;
      if (path === "/api/sync") {
        const sync: Sync = {
          collection_version: server.version,
          schema_version: server.schema,
          read_only: null,
          weeks: null,
        };
        return Response.json(sync);
      }
      if (path === `/api/v/collection/${server.version}`)
        return Response.json({ collection_version: server.version, cards: server.cards });
      const recipe = path.match(/^\/api\/v\/recipes\/([^/]+)\/(\d+)\/(\d+)$/);
      const found = recipe && server.cards.find((c) => c.id === recipe[1]);
      if (found && Number(recipe?.[2]) === found.recipe_version)
        return Response.json({ id: found.id, version: found.recipe_version });
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

function card(id: string, recipe_version: number, image_id: string | null): Card {
  return {
    id,
    recipe_version,
    preview: image_id ? { image_id, focal_x: 0.5, focal_y: 0.5 } : null,
  } as Card;
}

const A = card("recipe-a", 1, "photo-a");
const B = card("recipe-b", 1, "photo-b");

function memoryStore(): Store & { paths: (cache: CacheName) => string[] } {
  const caches = new Map<CacheName, Map<string, Response>>();
  const cache = (name: CacheName) => {
    const found = caches.get(name) ?? new Map<string, Response>();
    caches.set(name, found);
    return found;
  };
  const paths = (name: CacheName) => [...cache(name).keys()].sort();
  return {
    paths,
    match: async (name, path) => cache(name).get(path)?.clone(),
    put: async (name, path, response) => void cache(name).set(path, response.clone()),
    delete: async (name, path) => void cache(name).delete(path),
    keys: async (name) => paths(name),
  };
}

const recipePath = (id: string, version: number) =>
  `/api/v/recipes/${id}/${version}/${SCHEMA_VERSION}`;

function setup({ full = false, photoCap = 1000 } = {}) {
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
    });
  return { server, store, onSchemaChange, persist, engine };
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

    await visitor.recipe(B);
    await visitor.open(B);
    await visitor.prefetch();
    expect(store.paths(DATA)).toEqual(["/api/v/collection/1", recipePath("recipe-b", 1)]);
    expect(store.paths(CARDS)).toEqual(["/images/photo-b-card.webp"]);
    expect(store.paths(PHOTOS)).toEqual(["/images/photo-b.webp"]);
    expect(persist).not.toHaveBeenCalled();
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

describe("a new Collection version", () => {
  it("refetches only the recipes that changed and deletes what it supersedes", async () => {
    const { server, store, engine } = setup({ full: true });
    const installed = engine();
    await installed.poll();
    await installed.prefetch();
    server.took();

    server.version = 2;
    server.cards = [card("recipe-a", 1, "photo-a"), card("recipe-b", 2, "photo-b2")];
    await installed.poll();
    await installed.prefetch();

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
    await visitor.prefetch();

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
    let release = () => {};
    server.holdRecipes = new Promise((resolve) => {
      release = resolve;
    });
    const pass = installed.prefetch();

    server.version = 2;
    await installed.poll();
    void installed.prefetch();
    release();
    await pass;

    expect(store.paths(DATA)).toContain("/api/v/collection/2");
    expect(store.paths(DATA)).not.toContain("/api/v/collection/1");
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
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(polls()).toBe(0);

    doc.hidden = false;
    fire(doc, "visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(1);
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
