import { afterEach, describe, expect, it, vi } from "vitest";
import type { createApi, WeekPlan, WeekPlanEntry } from "./api/client";
import {
  CHANGED_ELSEWHERE,
  CHANGED_NOT_REFRESHED,
  createWeekStore,
  dayOperations,
  dayRowName,
  noticedWrite,
  plannedLabel,
  RECIPE_GONE,
  RECIPE_GONE_NOT_REFRESHED,
  STILL_SAVING,
  scaleLabel,
  type WeekWrite,
  writeNotice,
  writeToast,
} from "./weekPlan";

const MONDAY = "2026-11-02";

const entry = (recipe_id: string, entry_id = `${recipe_id}-entry`): WeekPlanEntry => ({
  entry_id,
  recipe_id,
  recipe_title: `Synthetic ${recipe_id}`,
  amount: { kind: "scale", factor: 1 },
});

const plan = (version: number, days: Record<number, WeekPlanEntry[]> = {}): WeekPlan => ({
  schema_version: 1,
  week_start: MONDAY,
  days: [0, 1, 2, 3, 4, 5, 6].map((day) => days[day] ?? []),
  grocery_ticks: [],
  version,
});

// A promise and the function that settles it, so a test decides when the API answers.
function later<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

const ok = (data: WeekPlan) => ({ data, response: new Response(null, { status: 200 }) });
const refused = (status: number) => ({
  error: { detail: "No" },
  response: new Response(null, { status }),
});

type Answer = { data?: WeekPlan; error?: unknown; response: Response };

function fakeApi() {
  const GET = vi.fn<() => Promise<Answer>>();
  const PATCH = vi.fn<(path: string, init: { body: unknown }) => Promise<Answer>>();
  return { GET, PATCH, api: { GET, PATCH } as unknown as ReturnType<typeof createApi> };
}

async function loaded(week: WeekPlan) {
  const fake = fakeApi();
  const onGone = vi.fn();
  const store = createWeekStore(fake.api, onGone);
  fake.GET.mockResolvedValueOnce(ok(week));
  await store.load(MONDAY);
  return { ...fake, store, onGone };
}

const place = { op: "place", day: 2, recipe_id: "a" } as const;

describe("plannedLabel", () => {
  it("is nothing when the recipe isn't in the week", () => {
    expect(plannedLabel(plan(1, { 0: [entry("b")] }), "a")).toBeUndefined();
    expect(plannedLabel(undefined, "a")).toBeUndefined();
  });

  it("names the day it's on", () => {
    expect(plannedLabel(plan(1, { 2: [entry("b"), entry("a")] }), "a")).toBe("✓ Wed");
  });

  it("names several days in order, and a day holding it twice once", () => {
    const week = plan(1, { 4: [entry("a")], 2: [entry("a", "x"), entry("a", "y")] });
    expect(plannedLabel(week, "a")).toBe("✓ Wed, Fri");
  });
});

describe("scaleLabel", () => {
  it.each([
    [0.5, "½×"],
    [1, "1×"],
    [1.5, "1½×"],
    [2, "2×"],
    [3, "3×"],
  ] as const)("writes %d as %s", (factor, label) => {
    expect(scaleLabel(factor)).toBe(label);
  });
});

describe("dayOperations", () => {
  it("places the recipe on a day it isn't on", () => {
    expect(dayOperations(plan(1, { 2: [entry("b")] }), 2, "a")).toEqual([
      { op: "place", day: 2, recipe_id: "a" },
    ]);
  });

  it("removes each of its entries on a day it's on, and no other entry", () => {
    const week = plan(1, {
      2: [entry("a", "x"), entry("b"), entry("a", "y")],
      3: [entry("a", "z")],
    });
    expect(dayOperations(week, 2, "a")).toEqual([
      { op: "remove", entry_id: "x" },
      { op: "remove", entry_id: "y" },
    ]);
  });
});

describe("dayRowName", () => {
  it("states what a tap does to the recipe on that day", () => {
    expect(dayRowName("Synthetic Soup", "Wed 4", { on: false, past: false })).toBe(
      "Add Synthetic Soup to Wed 4",
    );
    expect(dayRowName("Synthetic Soup", "Mon 2", { on: false, past: true })).toBe(
      "Log Synthetic Soup on Mon 2",
    );
    expect(dayRowName("Synthetic Soup", "Mon 2", { on: true, past: true })).toBe(
      "Remove Synthetic Soup from Mon 2",
    );
  });
});

describe("writeNotice", () => {
  it("says nothing of a write that went through or was held back", () => {
    expect(writeNotice({ kind: "saved" })).toBeUndefined();
    expect(writeNotice({ kind: "skipped" })).toBeUndefined();
  });

  it("says the week changed, and whether the newer one is showing", () => {
    expect(writeNotice({ kind: "conflict", refreshed: true })).toBe(CHANGED_ELSEWHERE);
    expect(writeNotice({ kind: "conflict", refreshed: false })).toBe(CHANGED_NOT_REFRESHED);
  });

  it("says the recipe is gone, and whether the latest plan is showing", () => {
    expect(writeNotice({ kind: "gone", refreshed: true })).toBe(RECIPE_GONE);
    expect(writeNotice({ kind: "gone", refreshed: false })).toBe(RECIPE_GONE_NOT_REFRESHED);
  });

  it("tells someone no longer an editor to sign in, and anyone else to try again", () => {
    expect(writeNotice({ kind: "not-an-editor" })).toMatch(/Sign in again/);
    expect(writeNotice({ kind: "failed" })).toMatch(/Try again/);
  });

  it("tells an editor whose tap was refused to tap again, briefly", () => {
    expect(writeNotice({ kind: "busy" })).toBe(STILL_SAVING);
    expect(writeToast({ kind: "busy" })).toEqual({ text: STILL_SAVING, brief: true });
    expect(writeToast({ kind: "failed" })?.brief).toBe(false);
    expect(writeToast({ kind: "saved" })).toBeNull();
  });
});

describe("noticedWrite", () => {
  const shown = () => {
    const show = vi.fn();
    return { show, last: () => show.mock.lastCall?.[0] };
  };

  it("keeps the notice of a refused tap when the write before it succeeds", async () => {
    const { show, last } = shown();
    const first = later<WeekWrite>();
    const writing = noticedWrite(() => first.promise, show);
    await noticedWrite(async () => ({ kind: "busy" }), show);
    expect(last()?.text).toBe(STILL_SAVING);
    first.settle({ kind: "saved" });
    await writing;
    expect(last()?.text).toBe(STILL_SAVING);
  });

  it("replaces that notice when the write before it fails", async () => {
    const { show, last } = shown();
    const first = later<WeekWrite>();
    const writing = noticedWrite(() => first.promise, show);
    await noticedWrite(async () => ({ kind: "busy" }), show);
    first.settle({ kind: "failed" });
    await writing;
    expect(last()?.text).toMatch(/Try again/);
  });

  it("clears an earlier notice as the next tap lands", async () => {
    const { show, last } = shown();
    await noticedWrite(async () => ({ kind: "failed" }), show);
    await noticedWrite(async () => ({ kind: "saved" }), show);
    expect(last()).toBeNull();
  });
});

describe("the week store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("has nothing before a load, and the plan after it", async () => {
    const { GET, api } = fakeApi();
    const store = createWeekStore(api, () => {});
    expect(store.week(MONDAY).plan).toBeUndefined();
    GET.mockResolvedValueOnce(ok(plan(0)));
    await store.load(MONDAY);
    expect(store.week(MONDAY).plan?.version).toBe(0);
  });

  it("says a load failed, on a refusal or with no network, and a later one clears it", async () => {
    const { GET, api } = fakeApi();
    const store = createWeekStore(api, () => {});
    GET.mockResolvedValueOnce(refused(403));
    await store.load(MONDAY);
    expect(store.week(MONDAY).failed).toBe(true);
    GET.mockRejectedValueOnce(new TypeError("offline"));
    await store.load(MONDAY);
    expect(store.week(MONDAY).failed).toBe(true);
    GET.mockResolvedValueOnce(ok(plan(3)));
    await store.load(MONDAY);
    expect(store.week(MONDAY)).toMatchObject({ failed: false, plan: { version: 3 } });
  });

  it("keeps the plan on screen when a reload fails", async () => {
    const { store, GET } = await loaded(plan(3));
    GET.mockRejectedValueOnce(new TypeError("offline"));
    await store.load(MONDAY);
    expect(store.week(MONDAY).plan?.version).toBe(3);
  });

  it("shares one load in flight between its callers", async () => {
    const { GET, api } = fakeApi();
    const store = createWeekStore(api, () => {});
    GET.mockResolvedValue(ok(plan(1)));
    await Promise.all([store.load(MONDAY), store.load(MONDAY)]);
    expect(GET).toHaveBeenCalledTimes(1);
  });

  it("tells its listeners, and stops once they leave", async () => {
    const { GET, api } = fakeApi();
    const store = createWeekStore(api, () => {});
    const listener = vi.fn();
    const leave = store.subscribe(listener);
    GET.mockResolvedValue(ok(plan(1)));
    await store.load(MONDAY);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    leave();
    await store.load(MONDAY);
    expect(listener).not.toHaveBeenCalled();
  });

  it("gives an unchanged week the same snapshot, as useSyncExternalStore needs", async () => {
    const { store } = await loaded(plan(1));
    expect(store.week(MONDAY)).toBe(store.week(MONDAY));
    expect(store.week("2026-11-09")).toBe(store.week("2026-11-09"));
  });

  it("writes at the version it last read and adopts the plan the API returns", async () => {
    vi.useFakeTimers();
    const { store, PATCH } = await loaded(plan(4));
    PATCH.mockResolvedValueOnce(ok(plan(5, { 2: [entry("a")] })));
    expect(await store.write(MONDAY, [place])).toEqual({ kind: "saved" });
    expect(PATCH.mock.calls[0]?.[1].body).toEqual({ version: 4, operations: [place] });
    expect(store.week(MONDAY).plan?.version).toBe(5);
    vi.runAllTimers();
    PATCH.mockResolvedValueOnce(ok(plan(6)));
    await store.write(MONDAY, [{ op: "remove", entry_id: "a-entry" }]);
    expect(PATCH.mock.calls[1]?.[1].body).toMatchObject({ version: 5 });
  });

  it("refuses a second write while one is in flight, so none goes out at a stale version", async () => {
    vi.useFakeTimers();
    const { store, PATCH } = await loaded(plan(4));
    const answer = later<Answer>();
    PATCH.mockReturnValueOnce(answer.promise);
    const first = store.write(MONDAY, [place]);
    expect(store.week(MONDAY).writing).toBe(true);
    expect(await store.write(MONDAY, [place])).toEqual({ kind: "busy" });
    expect(PATCH).toHaveBeenCalledTimes(1);
    answer.settle(ok(plan(5)));
    await first;
    vi.runAllTimers();
    expect(store.week(MONDAY).writing).toBe(false);
  });

  it("stays busy just after a save, so the second tap of a double-tap can't hit what moved", async () => {
    vi.useFakeTimers();
    const { store, PATCH } = await loaded(plan(4));
    PATCH.mockResolvedValueOnce(ok(plan(5)));
    await store.write(MONDAY, [place]);
    expect(store.week(MONDAY)).toMatchObject({ writing: true, plan: { version: 5 } });
    expect(await store.write(MONDAY, [place])).toEqual({ kind: "busy" });
    expect(PATCH).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(store.week(MONDAY).writing).toBe(false);
  });

  it("doesn't stay busy after a refused write, so a retry goes straight out", async () => {
    const { store, PATCH } = await loaded(plan(4));
    PATCH.mockRejectedValueOnce(new TypeError("offline"));
    await store.write(MONDAY, [place]);
    expect(store.week(MONDAY).writing).toBe(false);
  });

  it("writes nothing before the week has loaded", async () => {
    const { PATCH, api } = fakeApi();
    expect(await createWeekStore(api, () => {}).write(MONDAY, [place])).toEqual({
      kind: "skipped",
    });
    expect(PATCH).not.toHaveBeenCalled();
  });

  it("on a 409 reloads the week, says so, and doesn't retry", async () => {
    const { store, GET, PATCH } = await loaded(plan(4));
    PATCH.mockResolvedValueOnce(refused(409));
    GET.mockResolvedValueOnce(ok(plan(7)));
    expect(await store.write(MONDAY, [place])).toEqual({ kind: "conflict", refreshed: true });
    expect(store.week(MONDAY)).toMatchObject({ writing: false, plan: { version: 7 } });
    expect(PATCH).toHaveBeenCalledTimes(1);
  });

  it("on a 404 reloads the week, says the recipe is gone, and forgets the Collection", async () => {
    const { store, GET, PATCH, onGone } = await loaded(plan(4));
    PATCH.mockResolvedValueOnce(refused(404));
    GET.mockResolvedValueOnce(ok(plan(4, { 1: [entry("b")] })));
    expect(await store.write(MONDAY, [place])).toEqual({ kind: "gone", refreshed: true });
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(store.week(MONDAY).writing).toBe(false);
    expect(store.week(MONDAY).plan?.days[1]).toHaveLength(1);
  });

  it("says when the reload after a 404 failed", async () => {
    const { store, GET, PATCH } = await loaded(plan(4));
    PATCH.mockResolvedValueOnce(refused(404));
    GET.mockRejectedValueOnce(new TypeError("offline"));
    expect(await store.write(MONDAY, [place])).toEqual({ kind: "gone", refreshed: false });
  });

  it("takes a 404 for an entry as a conflict, as the recipe may well still exist", async () => {
    const { store, GET, PATCH, onGone } = await loaded(plan(4));
    PATCH.mockResolvedValueOnce(refused(404));
    GET.mockResolvedValueOnce(ok(plan(5)));
    const remove = { op: "remove", entry_id: "e" } as const;
    expect(await store.write(MONDAY, [remove])).toEqual({ kind: "conflict", refreshed: true });
    expect(onGone).not.toHaveBeenCalled();
  });

  it("takes a 404 with no API body as a failure, not a missing recipe", async () => {
    const { store, PATCH, onGone } = await loaded(plan(4));
    PATCH.mockResolvedValueOnce({ response: new Response(null, { status: 404 }) });
    expect(await store.write(MONDAY, [place])).toEqual({ kind: "failed" });
    expect(onGone).not.toHaveBeenCalled();
  });

  it("says when the reload after a conflict failed", async () => {
    const { store, GET, PATCH } = await loaded(plan(4));
    PATCH.mockResolvedValueOnce(refused(409));
    GET.mockRejectedValueOnce(new TypeError("offline"));
    expect(await store.write(MONDAY, [place])).toEqual({ kind: "conflict", refreshed: false });
  });

  it("holds writes back until the reload after a conflict has answered", async () => {
    const { store, GET, PATCH } = await loaded(plan(4));
    const reload = later<Answer>();
    PATCH.mockResolvedValueOnce(refused(409));
    GET.mockReturnValueOnce(reload.promise);
    const first = store.write(MONDAY, [place]);
    await vi.waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    expect(await store.write(MONDAY, [place])).toEqual({ kind: "busy" });
    reload.settle(ok(plan(5)));
    await first;
  });

  it("reports a refusal and a lost network, keeping the plan", async () => {
    const { store, PATCH } = await loaded(plan(4));
    PATCH.mockResolvedValueOnce(refused(403));
    expect(await store.write(MONDAY, [place])).toEqual({ kind: "not-an-editor" });
    PATCH.mockRejectedValueOnce(new TypeError("offline"));
    expect(await store.write(MONDAY, [place])).toEqual({ kind: "failed" });
    expect(store.week(MONDAY)).toMatchObject({ writing: false, plan: { version: 4 } });
  });

  it("ignores a read that started before a write and answers after it", async () => {
    const { store, GET, PATCH } = await loaded(plan(4));
    const read = later<Answer>();
    GET.mockReturnValueOnce(read.promise);
    const reading = store.load(MONDAY);
    PATCH.mockResolvedValueOnce(ok(plan(5)));
    await store.write(MONDAY, [place]);
    read.settle(ok(plan(4)));
    await reading;
    expect(store.week(MONDAY).plan?.version).toBe(5);
  });

  it("keeps a newer plan a read brought while the write was in flight", async () => {
    const { store, GET, PATCH } = await loaded(plan(4));
    const write = later<Answer>();
    PATCH.mockReturnValueOnce(write.promise);
    const writing = store.write(MONDAY, [place]);
    GET.mockResolvedValueOnce(ok(plan(6)));
    await store.load(MONDAY);
    write.settle(ok(plan(5)));
    expect(await writing).toEqual({ kind: "saved" });
    expect(store.week(MONDAY).plan?.version).toBe(6);
  });

  it("keeps each week's plan and its writes apart", async () => {
    const { store, GET, PATCH } = await loaded(plan(4));
    const answer = later<Answer>();
    PATCH.mockReturnValueOnce(answer.promise);
    const first = store.write(MONDAY, [place]);
    GET.mockResolvedValueOnce(ok({ ...plan(9), week_start: "2026-11-09" }));
    await store.load("2026-11-09");
    PATCH.mockResolvedValueOnce(ok({ ...plan(10), week_start: "2026-11-09" }));
    expect(await store.write("2026-11-09", [place])).toEqual({ kind: "saved" });
    answer.settle(ok(plan(5)));
    await first;
    expect(store.week(MONDAY).plan?.version).toBe(5);
  });

  describe("on clear, as at sign-out", () => {
    it("forgets every week", async () => {
      const { store } = await loaded(plan(4));
      store.clear();
      expect(store.week(MONDAY).plan).toBeUndefined();
    });

    it("tells its listeners", async () => {
      const { store } = await loaded(plan(4));
      const listener = vi.fn();
      store.subscribe(listener);
      store.clear();
      expect(listener).toHaveBeenCalled();
    });

    it("drops a load in flight, so its answer can't bring the week back", async () => {
      const { GET, api } = fakeApi();
      const store = createWeekStore(api, () => {});
      const read = later<Answer>();
      GET.mockReturnValueOnce(read.promise);
      const reading = store.load(MONDAY);
      store.clear();
      read.settle(ok(plan(4)));
      await reading;
      expect(store.week(MONDAY).plan).toBeUndefined();
    });

    it("drops a write in flight the same way", async () => {
      const { store, PATCH } = await loaded(plan(4));
      const answer = later<Answer>();
      PATCH.mockReturnValueOnce(answer.promise);
      const writing = store.write(MONDAY, [place]);
      store.clear();
      answer.settle(ok(plan(5)));
      expect(await writing).toEqual({ kind: "skipped" });
      expect(store.week(MONDAY).plan).toBeUndefined();
    });

    it("can't bring a week back from the pause after a save", async () => {
      vi.useFakeTimers();
      const { store, PATCH } = await loaded(plan(4));
      PATCH.mockResolvedValueOnce(ok(plan(5)));
      await store.write(MONDAY, [place]);
      store.clear();
      vi.runAllTimers();
      expect(store.week(MONDAY)).toEqual({ failed: false, writing: false });
    });

    it("loads afresh afterwards, not joining a dropped load", async () => {
      const { GET, api } = fakeApi();
      const store = createWeekStore(api, () => {});
      const read = later<Answer>();
      GET.mockReturnValueOnce(read.promise);
      void store.load(MONDAY);
      store.clear();
      GET.mockResolvedValueOnce(ok(plan(2)));
      await store.load(MONDAY);
      expect(store.week(MONDAY).plan?.version).toBe(2);
    });
  });
});
