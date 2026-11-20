import { useSyncExternalStore } from "react";

export type TickStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const keyOf = (recipeId: string) => `plateful.ticks.${recipeId}`;
const NONE: ReadonlySet<string> = new Set();

function read(storage: TickStorage | undefined, recipeId: string): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(keyOf(recipeId)) ?? "null");
    if (Array.isArray(value)) return new Set(value.filter((id) => typeof id === "string"));
  } catch {
    // Unreadable or blocked storage: no ticks.
  }
  return NONE;
}

function write(storage: TickStorage | undefined, recipeId: string, ticks: ReadonlySet<string>) {
  try {
    if (ticks.size === 0) storage?.removeItem(keyOf(recipeId));
    else storage?.setItem(keyOf(recipeId), JSON.stringify([...ticks]));
  } catch {
    // Storage is a convenience: without it the ticks last as long as the page.
  }
}

/**
 * The Step ticks, by recipe: the ids of the steps a cook has marked done, kept on this device only.
 * Step ids are never reused, so a tick on a step since removed matches nothing.
 */
export function createStepTickStore(storage: TickStorage | undefined) {
  const byRecipe = new Map<string, ReadonlySet<string>>();
  const listeners = new Set<() => void>();

  const snapshot = (recipeId: string) => {
    let ticks = byRecipe.get(recipeId);
    if (!ticks) {
      ticks = read(storage, recipeId);
      byRecipe.set(recipeId, ticks);
    }
    return ticks;
  };

  const change = (recipeId: string, ticks: ReadonlySet<string>) => {
    byRecipe.set(recipeId, ticks);
    write(storage, recipeId, ticks);
    for (const listener of listeners) listener();
  };

  const set = (recipeId: string, stepId: string, done: boolean) => {
    const ticks = snapshot(recipeId);
    if (ticks.has(stepId) === done) return;
    const next = new Set(ticks);
    if (done) next.add(stepId);
    else next.delete(stepId);
    change(recipeId, next);
  };

  return {
    /** The recipe's ticks, unfiltered; the same set until they change. */
    snapshot,
    /** The ticked ids among `stepIds`, the recipe's current steps, in their order. */
    ticked: (recipeId: string, stepIds: readonly string[]): ReadonlySet<string> => {
      const ticks = snapshot(recipeId);
      return new Set(stepIds.filter((id) => ticks.has(id)));
    },
    set,
    tick: (recipeId: string, stepId: string) => set(recipeId, stepId, true),
    toggle: (recipeId: string, stepId: string) =>
      set(recipeId, stepId, !snapshot(recipeId).has(stepId)),
    clear: (recipeId: string) => {
      if (snapshot(recipeId).size > 0) change(recipeId, NONE);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function browserStorage(): TickStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

// The app's one tick store, so the recipe page and anything else showing a recipe agree.
export const stepTicks = createStepTickStore(browserStorage());

/** The ids of the recipe's ticked steps. A step no longer in the recipe may be among them. */
export function useStepTicks(recipeId: string): ReadonlySet<string> {
  const get = () => stepTicks.snapshot(recipeId);
  return useSyncExternalStore(stepTicks.subscribe, get, get);
}
