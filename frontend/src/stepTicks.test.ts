import { describe, expect, it, vi } from "vitest";
import { createStepTickStore, type TickStorage } from "./stepTicks";

function memoryStorage(): TickStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const steps = ["s1", "s2", "s3"];

describe("createStepTickStore", () => {
  it("starts with no Step ticks", () => {
    const store = createStepTickStore(memoryStorage());
    expect([...store.ticked("r1", steps)]).toEqual([]);
  });

  it("toggles a step's tick on and off", () => {
    const store = createStepTickStore(memoryStorage());
    store.toggle("r1", "s2");
    expect([...store.ticked("r1", steps)]).toEqual(["s2"]);
    store.toggle("r1", "s2");
    expect([...store.ticked("r1", steps)]).toEqual([]);
  });

  it("ticks a step, and ticking it again keeps it ticked", () => {
    const store = createStepTickStore(memoryStorage());
    store.tick("r1", "s1");
    store.tick("r1", "s1");
    expect([...store.ticked("r1", steps)]).toEqual(["s1"]);
    store.set("r1", "s1", false);
    expect([...store.ticked("r1", steps)]).toEqual([]);
  });

  it("keeps each recipe's ticks apart", () => {
    const store = createStepTickStore(memoryStorage());
    store.tick("r1", "s1");
    store.tick("r2", "s3");
    expect([...store.ticked("r1", steps)]).toEqual(["s1"]);
    expect([...store.ticked("r2", steps)]).toEqual(["s3"]);
  });

  it("keeps ticks on the device, under the recipe's key", () => {
    const storage = memoryStorage();
    createStepTickStore(storage).tick("r1", "s2");
    expect(JSON.parse(storage.items.get("plateful.ticks.r1") ?? "null")).toEqual(["s2"]);
    expect([...createStepTickStore(storage).ticked("r1", steps)]).toEqual(["s2"]);
  });

  it("reads only ticks on the recipe's current steps, in step order", () => {
    const storage = memoryStorage();
    storage.items.set("plateful.ticks.r1", JSON.stringify(["s3", "s9", "s1"]));
    expect([...createStepTickStore(storage).ticked("r1", steps)]).toEqual(["s1", "s3"]);
  });

  it("ignores stored ticks it can't read", () => {
    const storage = memoryStorage();
    storage.items.set("plateful.ticks.r1", "not json");
    storage.items.set("plateful.ticks.r2", JSON.stringify({ s1: true }));
    storage.items.set("plateful.ticks.r3", JSON.stringify(["s1", 2]));
    const store = createStepTickStore(storage);
    expect([...store.ticked("r1", steps)]).toEqual([]);
    expect([...store.ticked("r2", steps)]).toEqual([]);
    expect([...store.ticked("r3", steps)]).toEqual(["s1"]);
  });

  it("clears every tick of one recipe, from the device too", () => {
    const storage = memoryStorage();
    const store = createStepTickStore(storage);
    store.tick("r1", "s1");
    store.tick("r1", "s2");
    store.tick("r2", "s1");
    store.clear("r1");
    expect([...store.ticked("r1", steps)]).toEqual([]);
    expect(storage.items.has("plateful.ticks.r1")).toBe(false);
    expect([...store.ticked("r2", steps)]).toEqual(["s1"]);
  });

  it("removes the key once the last tick goes", () => {
    const storage = memoryStorage();
    const store = createStepTickStore(storage);
    store.toggle("r1", "s1");
    store.toggle("r1", "s1");
    expect(storage.items.has("plateful.ticks.r1")).toBe(false);
  });

  it("still ticks, for the page's life, when storage throws or is missing", () => {
    const broken: TickStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    for (const storage of [broken, undefined]) {
      const store = createStepTickStore(storage);
      store.tick("r1", "s1");
      expect([...store.ticked("r1", steps)]).toEqual(["s1"]);
      store.clear("r1");
      expect([...store.ticked("r1", steps)]).toEqual([]);
    }
  });

  it("tells subscribers of a change, and keeps a recipe's snapshot until it changes", () => {
    const store = createStepTickStore(memoryStorage());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.snapshot("r1");
    expect(store.snapshot("r1")).toBe(before);
    store.tick("r1", "s1");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.snapshot("r1")).not.toBe(before);
    expect(store.snapshot("r1").has("s1")).toBe(true);
    unsubscribe();
    store.clear("r1");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
