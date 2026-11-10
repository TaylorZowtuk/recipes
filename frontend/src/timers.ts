import { useSyncExternalStore } from "react";
import { ring, type Sound, unlockSound } from "./timerSound";

const TICK_MS = 250;
const ALARM_EVERY_MS = 3_000;
const NOTICE_MS = 3_000;
const MINUTE_MS = 60_000;

// What a duration in a step starts. `position` is the segment's place in the step, so two durations
// in one step are separate timers. A range's `lowS` is below its `highS`; a single duration has them
// equal.
export type TimerStart = {
  recipeId: string;
  recipeTitle: string;
  stepId: string;
  stepNumber: number;
  position: number;
  written: string;
  lowS: number;
  highS: number;
};

// `counting` is before the first thing to sound, `chimed` between a range's two ends.
type Phase = "counting" | "chimed" | "alarming";

export type TimerView = TimerStart & {
  id: string;
  phase: Phase;
  paused: boolean;
  countdown: string;
  named: string;
};

// The thresholds are wall-clock times, so a throttled page catches up on its next tick. A single
// duration has no `chimeAt`. Resuming moves the thresholds on by the time spent paused.
type Timer = TimerStart & {
  id: string;
  chimeAt: number | null;
  alarmAt: number;
  pausedAt: number | null;
  chimeRung: boolean;
  alarmRungAt: number | null;
};

function phaseAt(timer: Timer, now: number): Phase {
  const at = timer.pausedAt ?? now;
  if (at >= timer.alarmAt) return "alarming";
  return timer.chimeAt !== null && at >= timer.chimeAt ? "chimed" : "counting";
}

const describeTimer = (timer: TimerStart) =>
  `${timer.written}, step ${timer.stepNumber} of ${timer.recipeTitle}`;

const pad = (n: number) => String(n).padStart(2, "0");

function clockText(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = pad(seconds % 60);
  return hours ? `${hours}:${pad(minutes)}:${rest}` : `${minutes}:${rest}`;
}

// The time to the next threshold, worded so the check-early phase can't pass for the final one.
function countdownAt(timer: Timer, now: number): string {
  const phase = phaseAt(timer, now);
  if (phase === "alarming") return "Time’s up";
  const { chimeAt, alarmAt, pausedAt } = timer;
  const check = phase === "counting" && chimeAt !== null;
  const seconds = Math.ceil(((check ? chimeAt : alarmAt) - (pausedAt ?? now)) / 1000);
  return `${check ? "Check" : "Done"} in ${clockText(seconds)}`;
}

function viewAt(timer: Timer, now: number): TimerView {
  const { chimeAt, alarmAt, pausedAt, chimeRung, alarmRungAt, ...shown } = timer;
  return {
    ...shown,
    phase: phaseAt(timer, now),
    paused: pausedAt !== null,
    countdown: countdownAt(timer, now),
    named: describeTimer(timer),
  };
}

// A minute more on each threshold still ahead. An alarming timer falls silent and gets a minute
// from now, however long it has been alarming.
function addMinuteTo(timer: Timer, now: number): Timer {
  const phase = phaseAt(timer, now);
  if (phase === "alarming") return { ...timer, alarmAt: now + MINUTE_MS, alarmRungAt: null };
  const { chimeAt, alarmAt } = timer;
  const chimeAhead = phase === "counting" && chimeAt !== null;
  return {
    ...timer,
    alarmAt: alarmAt + MINUTE_MS,
    chimeAt: chimeAhead ? chimeAt + MINUTE_MS : chimeAt,
  };
}

function resumed(timer: Timer, now: number): Timer {
  if (timer.pausedAt === null) return timer;
  const paused = now - timer.pausedAt;
  return {
    ...timer,
    pausedAt: null,
    alarmAt: timer.alarmAt + paused,
    chimeAt: timer.chimeAt === null ? null : timer.chimeAt + paused,
  };
}

/**
 * The running timers, in memory only, and the dock's latest notice. `now` is the wall clock. Every
 * command runs in a tap, the only thing that can wake the audio on iOS, so each one unlocks it.
 */
export function createTimerStore(
  now: () => number,
  sound: { unlock: () => void; ring: (sound: Sound) => void },
) {
  let timers: Timer[] = [];
  let notice: string | null = null;
  let noticeGone: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let shown: { timers: TimerView[]; notice: string | null } = { timers: [], notice };
  const listeners = new Set<() => void>();

  function publish() {
    const at = now();
    const next = { timers: timers.map((timer) => viewAt(timer, at)), notice };
    if (JSON.stringify(next) === JSON.stringify(shown)) return;
    shown = next;
    for (const listener of listeners) listener();
  }

  // What arrives while a notice shows joins it, so neither is lost, and a repeat adds nothing.
  function say(text: string) {
    clearTimeout(noticeGone);
    if (!notice?.includes(text)) notice = notice ? `${notice} ${text}` : text;
    noticeGone = setTimeout(() => {
      notice = null;
      publish();
    }, NOTICE_MS);
  }

  // Sounds what has come due. A gap that passes both ends of a range sounds only the alarm.
  function rungAt(timer: Timer, at: number): Timer {
    if (timer.pausedAt !== null) return timer;
    const phase = phaseAt(timer, at);
    if (phase === "alarming") {
      const { alarmRungAt } = timer;
      if (alarmRungAt !== null && at - alarmRungAt < ALARM_EVERY_MS) return timer;
      sound.ring("alarm");
      if (alarmRungAt === null) say(`Time’s up for the ${describeTimer(timer)}.`);
      return { ...timer, chimeRung: true, alarmRungAt: at };
    }
    if (phase === "chimed" && !timer.chimeRung) {
      sound.ring("chime");
      say(`Check the ${describeTimer(timer)}.`);
      return { ...timer, chimeRung: true };
    }
    return timer;
  }

  function settle() {
    const at = now();
    timers = timers.map((timer) => rungAt(timer, at));
    const running = timers.some((timer) => timer.pausedAt === null);
    if (running && ticker === undefined) ticker = setInterval(settle, TICK_MS);
    if (!running) {
      clearInterval(ticker);
      ticker = undefined;
    }
    publish();
  }

  function change(id: string, changed: (timer: Timer, at: number) => Timer) {
    sound.unlock();
    const at = now();
    timers = timers.map((timer) => (timer.id === id ? changed(timer, at) : timer));
    settle();
  }

  return {
    start(start: TimerStart) {
      sound.unlock();
      const id = `${start.recipeId}/${start.stepId}/${start.position}`;
      if (timers.some((timer) => timer.id === id)) {
        say(`The ${start.written} timer is already running.`);
        publish();
        return;
      }
      const at = now();
      timers = [
        ...timers,
        {
          ...start,
          id,
          chimeAt: start.lowS < start.highS ? at + start.lowS * 1000 : null,
          alarmAt: at + start.highS * 1000,
          pausedAt: null,
          chimeRung: false,
          alarmRungAt: null,
        },
      ];
      settle();
    },
    pause: (id: string) =>
      change(id, (timer, at) =>
        timer.pausedAt !== null || phaseAt(timer, at) === "alarming"
          ? timer
          : { ...timer, pausedAt: at },
      ),
    resume: (id: string) => change(id, resumed),
    addMinute: (id: string) => change(id, addMinuteTo),
    cancel(id: string) {
      sound.unlock();
      timers = timers.filter((timer) => timer.id !== id);
      settle();
    },
    // For what only a screen knows, shown where the cook is looking.
    notify(text: string) {
      say(text);
      publish();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => shown,
  };
}

export const timers = createTimerStore(Date.now, { unlock: unlockSound, ring });

/** The dock's timers and notice. */
export const useTimers = () =>
  useSyncExternalStore(timers.subscribe, timers.snapshot, timers.snapshot);
