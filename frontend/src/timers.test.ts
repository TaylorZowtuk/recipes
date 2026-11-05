import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createTimerStore, type TimerStart } from "./timers";

const MINUTE = 60_000;

const fry: TimerStart = {
  recipeId: "01K7TEST000000000000000001",
  recipeTitle: "Synthetic Test Noodles",
  stepId: "s3",
  stepNumber: 3,
  position: 1,
  written: "8-10 minutes",
  lowS: 480,
  highS: 600,
};
const rest: TimerStart = { ...fry, position: 3, written: "10 minutes", lowS: 600, highS: 600 };

describe("the timer store", () => {
  let clock: number;
  let sounds: string[];
  let unlock: Mock<() => void>;
  let store: ReturnType<typeof createTimerStore>;

  // The wall clock moves by `ms`, and the page's ticker gets one go at it, however long that was.
  const passing = (ms: number) => {
    clock += ms;
    vi.advanceTimersToNextTimer();
  };
  // A second at a time, as a page in the foreground ticks.
  const run = (ms: number) => {
    for (let left = ms; left > 0; left -= 1000) passing(Math.min(1000, left));
  };
  const shown = (n = 0) => {
    const timer = store.snapshot().timers[n];
    if (!timer) throw new Error(`no timer ${n}`);
    return timer;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    sounds = [];
    unlock = vi.fn();
    store = createTimerStore(() => clock, { unlock, ring: (sound) => sounds.push(sound) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wakes the audio on every command, as each runs in a tap", () => {
    const commands = [
      () => store.start(fry),
      () => store.start(fry),
      () => store.pause(shown().id),
      () => store.resume(shown().id),
      () => store.addMinute(shown().id),
      () => store.cancel(shown().id),
    ];
    commands.forEach((command, done) => {
      expect(unlock).toHaveBeenCalledTimes(done);
      command();
    });
    expect(unlock).toHaveBeenCalledTimes(commands.length);
  });

  it("leaves the audio alone when only the clock moves", () => {
    store.start(rest);
    unlock.mockClear();
    run(11 * MINUTE);
    expect(sounds).not.toEqual([]);
    expect(unlock).not.toHaveBeenCalled();
  });

  it("runs several timers at once, two in one step apart", () => {
    store.start(fry);
    store.start(rest);
    store.start({ ...fry, stepId: "s4", stepNumber: 4 });
    run(MINUTE);
    expect(store.snapshot().timers.map((timer) => timer.countdown)).toEqual([
      "Check in 7:00",
      "Done in 9:00",
      "Check in 7:00",
    ]);
  });

  it("chimes once at the low end, then counts to the high end", () => {
    store.start(fry);
    expect(shown()).toMatchObject({
      phase: "counting",
      countdown: "Check in 8:00",
      named: "8-10 minutes, step 3 of Synthetic Test Noodles",
    });
    run(8 * MINUTE - 1000);
    expect(sounds).toEqual([]);
    run(1000);
    expect(sounds).toEqual(["chime"]);
    expect(shown()).toMatchObject({ phase: "chimed", countdown: "Done in 2:00" });
    run(MINUTE);
    expect(sounds).toEqual(["chime"]);
  });

  it("alarms at the high end, repeating until cancelled", () => {
    store.start(fry);
    run(10 * MINUTE);
    expect(sounds).toEqual(["chime", "alarm"]);
    expect(shown()).toMatchObject({ phase: "alarming", countdown: "Time’s up" });
    run(30_000);
    expect(sounds.filter((sound) => sound === "alarm")).toHaveLength(11);
    store.cancel(shown().id);
    const rung = sounds.length;
    clock += MINUTE;
    vi.runOnlyPendingTimers();
    expect(sounds).toHaveLength(rung);
  });

  it("gives a single duration no chime, only the alarm", () => {
    store.start(rest);
    expect(shown().countdown).toBe("Done in 10:00");
    run(10 * MINUTE - 1000);
    expect(sounds).toEqual([]);
    expect(shown().phase).toBe("counting");
    run(1000);
    expect(sounds).toEqual(["alarm"]);
    expect(shown().phase).toBe("alarming");
  });

  it("freezes the countdown while paused, and picks up where it left off", () => {
    store.start(fry);
    run(MINUTE);
    store.pause(shown().id);
    expect(shown()).toMatchObject({ paused: true, countdown: "Check in 7:00" });
    clock += 30 * MINUTE;
    store.resume(shown().id);
    expect(shown()).toMatchObject({ paused: false, countdown: "Check in 7:00" });
    expect(sounds).toEqual([]);
    run(7 * MINUTE);
    expect(sounds).toEqual(["chime"]);
  });

  it("keeps a paused timer frozen while another runs past its ends", () => {
    store.start(fry);
    store.start(rest);
    run(MINUTE);
    store.pause(shown().id);
    run(20 * MINUTE);
    expect(shown()).toMatchObject({ paused: true, phase: "counting", countdown: "Check in 7:00" });
    expect(shown(1).phase).toBe("alarming");
  });

  it("doesn't pause a timer that is alarming", () => {
    store.start(rest);
    run(10 * MINUTE);
    store.pause(shown().id);
    expect(shown()).toMatchObject({ paused: false, phase: "alarming" });
  });

  it("adds a minute to both ends before the chime", () => {
    store.start(fry);
    store.addMinute(shown().id);
    expect(shown().countdown).toBe("Check in 9:00");
    run(8 * MINUTE);
    expect(sounds).toEqual([]);
    run(MINUTE);
    expect(sounds).toEqual(["chime"]);
    expect(shown().countdown).toBe("Done in 2:00");
  });

  it("adds a minute to the high end after the chime, without repeating it", () => {
    store.start(fry);
    run(8 * MINUTE + 30_000);
    expect(shown().countdown).toBe("Done in 1:30");
    store.addMinute(shown().id);
    expect(shown()).toMatchObject({ phase: "chimed", countdown: "Done in 2:30" });
    run(2 * MINUTE);
    expect(sounds).toEqual(["chime"]);
    run(30_000);
    expect(sounds).toEqual(["chime", "alarm"]);
  });

  it("adds a minute to a paused timer, which stays paused", () => {
    store.start(fry);
    store.pause(shown().id);
    store.addMinute(shown().id);
    clock += MINUTE;
    expect(shown()).toMatchObject({ paused: true, countdown: "Check in 9:00" });
  });

  it("silences an alarming timer for a minute from now", () => {
    store.start(fry);
    run(11 * MINUTE);
    store.addMinute(shown().id);
    expect(shown()).toMatchObject({ phase: "chimed", countdown: "Done in 1:00" });
    const rung = sounds.length;
    run(MINUTE - 1000);
    expect(sounds).toHaveLength(rung);
    expect(store.snapshot().notice).toBeNull();
    run(1000);
    expect(sounds).toHaveLength(rung + 1);
    expect(sounds.at(-1)).toBe("alarm");
    expect(shown().phase).toBe("alarming");
    expect(store.snapshot().notice).toBe(
      "Time’s up for the 8-10 minutes, step 3 of Synthetic Test Noodles.",
    );
  });

  it("refuses a duplicate start, leaving the timer as it was and saying so", () => {
    store.start(fry);
    run(MINUTE);
    store.start(fry);
    expect(store.snapshot().timers).toHaveLength(1);
    expect(shown().countdown).toBe("Check in 7:00");
    expect(store.snapshot().notice).toBe("The 8-10 minutes timer is already running.");
  });

  it("starts the same step of another recipe, as step ids repeat across recipes", () => {
    store.start(fry);
    store.start({ ...fry, recipeId: "01K7TEST000000000000000002" });
    expect(store.snapshot().timers).toHaveLength(2);
    expect(store.snapshot().notice).toBeNull();
  });

  it("refuses a duplicate of a paused or alarming timer, as it's still in the dock", () => {
    store.start(fry);
    store.pause(shown().id);
    store.start(fry);
    store.resume(shown().id);
    run(10 * MINUTE);
    store.start(fry);
    expect(store.snapshot().timers).toHaveLength(1);
  });

  it("takes the notice away after a moment, even with every timer paused", () => {
    store.start(fry);
    store.pause(shown().id);
    store.start(fry);
    expect(store.snapshot().notice).not.toBeNull();
    vi.advanceTimersByTime(3000);
    expect(store.snapshot().notice).toBeNull();
  });

  it("gives a later notice its full time", () => {
    store.start(fry);
    store.start(rest);
    store.start(fry);
    vi.advanceTimersByTime(2000);
    store.start(rest);
    vi.advanceTimersByTime(2999);
    expect(store.snapshot().notice).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(store.snapshot().notice).toBeNull();
  });

  it("starts a timer afresh once it's cancelled", () => {
    store.start(fry);
    run(MINUTE);
    store.cancel(shown().id);
    expect(store.snapshot().timers).toEqual([]);
    store.start(fry);
    expect(shown().countdown).toBe("Check in 8:00");
    expect(store.snapshot().notice).toBeNull();
  });

  it("catches up from the wall clock after a long gap in ticks", () => {
    store.start(fry);
    passing(9 * MINUTE);
    expect(shown()).toMatchObject({ phase: "chimed", countdown: "Done in 1:00" });
    expect(sounds).toEqual(["chime"]);
  });

  it("sounds only the alarm when a gap passes both ends, and no chime after +1 minute", () => {
    store.start(fry);
    passing(60 * MINUTE);
    expect(shown().phase).toBe("alarming");
    expect(sounds).toEqual(["alarm"]);
    store.addMinute(shown().id);
    run(10_000);
    expect(sounds).toEqual(["alarm"]);
  });

  it("announces the chime and the alarm", () => {
    store.start(fry);
    run(8 * MINUTE);
    expect(store.snapshot().notice).toBe(
      "Check the 8-10 minutes, step 3 of Synthetic Test Noodles.",
    );
    run(2 * MINUTE);
    expect(store.snapshot().notice).toBe(
      "Time’s up for the 8-10 minutes, step 3 of Synthetic Test Noodles.",
    );
  });

  it("says both when two timers come due on one tick, for as long as one", () => {
    store.start(rest);
    store.start({ ...rest, position: 5, written: "ten minutes" });
    run(10 * MINUTE);
    expect(store.snapshot().notice).toBe(
      "Time’s up for the 10 minutes, step 3 of Synthetic Test Noodles. " +
        "Time’s up for the ten minutes, step 3 of Synthetic Test Noodles.",
    );
    store.cancel(shown().id);
    store.cancel(shown().id);
    vi.advanceTimersByTime(3000);
    expect(store.snapshot().notice).toBeNull();
  });

  it("says a repeat once", () => {
    store.start(fry);
    store.start(fry);
    store.start(fry);
    expect(store.snapshot().notice).toBe("The 8-10 minutes timer is already running.");
  });

  it("keeps its snapshot until what it shows changes", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    const empty = store.snapshot();
    expect(store.snapshot()).toBe(empty);
    store.start(fry);
    expect(listener).toHaveBeenCalledTimes(1);
    const started = store.snapshot();
    expect(started).not.toBe(empty);
    passing(250);
    expect(store.snapshot()).toBe(started);
    expect(listener).toHaveBeenCalledTimes(1);
    passing(1000);
    expect(store.snapshot()).not.toBe(started);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("ticks only while a timer is running", () => {
    expect(vi.getTimerCount()).toBe(0);
    store.start(fry);
    expect(vi.getTimerCount()).toBe(1);
    store.pause(shown().id);
    expect(vi.getTimerCount()).toBe(0);
    store.resume(shown().id);
    expect(vi.getTimerCount()).toBe(1);
    store.cancel(shown().id);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops listening when asked", () => {
    const listener = vi.fn();
    store.subscribe(listener)();
    store.start(fry);
    expect(listener).not.toHaveBeenCalled();
  });

  it("shows hours when a timer runs past one", () => {
    store.start({ ...fry, lowS: 4200, highS: 4800 });
    expect(shown().countdown).toBe("Check in 1:10:00");
  });
});
