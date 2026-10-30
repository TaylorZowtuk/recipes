import { useCallback, useEffect, useState } from "react";
import { api, type Card, type Collection, type Recipe, type Sync } from "./api/client";

// One sync poll and one Collection bundle per page load, shared by the shell and every screen. A
// failed request is forgotten, so the next caller tries again.
let sync: Promise<Sync> | undefined;
let collection: Promise<Collection> | undefined;
let loadedCollection: Collection | undefined;
const recipes = new Map<string, Recipe>();

export class NotFound extends Error {}

function remembered<T>(promise: Promise<T>, forget: () => void): Promise<T> {
  promise.catch(forget);
  return promise;
}

export function loadSync(): Promise<Sync> {
  sync ??= remembered(
    api.GET("/api/sync").then(({ data }) => data ?? Promise.reject(new Error("No sync response"))),
    () => {
      sync = undefined;
    },
  );
  return sync;
}

// The bundle at the version sync reports, so the request hits its immutable URL.
export function loadCollection(): Promise<Collection> {
  collection ??= remembered(
    loadSync().then(async ({ collection_version }) => {
      const { data } = await api.GET("/api/v/collection/{collection_version}", {
        params: { path: { collection_version } },
      });
      if (!data) throw new Error("No collection response");
      loadedCollection = data;
      return data;
    }),
    () => {
      collection = undefined;
    },
  );
  return collection;
}

const forgotten = new Set<() => void>();

// Forgets the sync and the Collection after this device changes the Collection, so the next
// screen to ask loads the new version instead of this page load's copy, and `useSync` reloads.
export function forgetCollection() {
  sync = undefined;
  collection = undefined;
  loadedCollection = undefined;
  for (const listener of forgotten) listener();
}

// The sync poll: undefined until it answers, null when it failed. It loads again after this device
// changes the Collection, and when the network comes back, which asks again only after a failure.
export function useSync(): Sync | null | undefined {
  const [polled, setPolled] = useState<{ sync: Sync | null }>();
  useEffect(() => {
    let current = true;
    const load = () =>
      loadSync().then(
        (sync) => current && setPolled({ sync }),
        () => current && setPolled({ sync: null }),
      );
    load();
    forgotten.add(load);
    window.addEventListener("online", load);
    return () => {
      current = false;
      forgotten.delete(load);
      window.removeEventListener("online", load);
    };
  }, []);
  return polled?.sync;
}

// A recipe at its card's version and the schema version, its immutable URL.
export async function loadRecipe(card: Card): Promise<Recipe> {
  const key = `${card.id}@${card.recipe_version}`;
  const known = recipes.get(key);
  if (known) return known;
  const { schema_version } = await loadSync();
  const { data, response } = await api.GET(
    "/api/v/recipes/{recipe_id}/{recipe_version}/{schema_version}",
    {
      params: { path: { recipe_id: card.id, recipe_version: card.recipe_version, schema_version } },
    },
  );
  if (response.status === 404) throw new NotFound(card.id);
  if (!data) throw new Error(`No recipe ${card.id}`);
  recipes.set(key, data);
  return data;
}

export type Loaded<T> =
  | { state: "loading" }
  | { state: "failed"; notFound: boolean; retry: () => void }
  | { state: "ready"; value: T };

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
      (error) => settle({ state: "failed", notFound: error instanceof NotFound, retry }),
    );
    return () => {
      current = false;
    };
  }, [key, attempt, retry]);

  if (result?.key === key && result.attempt === attempt) return result.loaded;
  return cached === undefined ? { state: "loading" } : { state: "ready", value: cached };
}

// The Collection. After this device changes it, a screen showing it switches to the new version
// once that has loaded, keeping the old one on screen meanwhile.
export function useCollection(): Loaded<Collection> {
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let current = true;
    const reloaded = () => current && setReloads((n) => n + 1);
    const reload = () => loadCollection().then(reloaded, reloaded);
    forgotten.add(reload);
    return () => {
      current = false;
      forgotten.delete(reload);
    };
  }, []);
  return useLoaded(`collection@${reloads}`, loadCollection, loadedCollection);
}

// Keeps a recipe the API just returned, so its page shows it without loading it again.
export function rememberRecipe(recipe: Recipe) {
  recipes.set(`${recipe.id}@${recipe.version}`, recipe);
}

// Waits while there is no card, so a screen can call it before the Collection has loaded.
export function useRecipe(card: Card | undefined): Loaded<Recipe> {
  const key = card ? `${card.id}@${card.recipe_version}` : "";
  return useLoaded(key, card && (() => loadRecipe(card)), recipes.get(key));
}
