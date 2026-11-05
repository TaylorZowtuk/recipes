import { useEffect, useLayoutEffect, useRef } from "react";
import { Link } from "react-router";
import { CloseIcon, PauseIcon, PlayIcon } from "./icons";
import { focusTitle } from "./Screen";
import { recipePath } from "./slug";
import { type TimerView, timers, useTimers } from "./timers";

const PHASE_CLASS = { counting: "", chimed: " timer-chimed", alarming: " timer-alarming" };

// The running Timers, floating above the tab bar on every screen, and a status region for what they
// say. Its height goes in --dock-height, 0 while hidden, so the rest of the page can stay clear of it.
export function TimerDock() {
  const { timers: running, notice } = useTimers();
  const dock = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new ResizeObserver(() =>
      root.style.setProperty("--dock-height", `${dock.current?.offsetHeight ?? 0}px`),
    );
    if (dock.current) observer.observe(dock.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={dock} className="timer-dock" aria-label="Timers" hidden={running.length === 0}>
      <div className="timer-dock-panel">
        <p role="status" className="timer-notice">
          {notice}
        </p>
        <ul className="timer-list">
          {running.map((timer) => (
            <TimerRow key={timer.id} timer={timer} />
          ))}
        </ul>
      </div>
    </section>
  );
}

// Scrolls the list alone: the dock is fixed, so the page has no part in showing a row. WebKit
// truncates scrollTop, so a scroll down rounds up to clear the row's last fraction of a pixel.
function reveal(row: HTMLElement | null) {
  const list = row?.parentElement;
  if (!row || !list) return;
  const { top, bottom } = row.getBoundingClientRect();
  const shown = list.getBoundingClientRect();
  list.scrollTop +=
    top < shown.top ? top - shown.top : Math.max(0, Math.ceil(bottom - shown.bottom));
}

function TimerRow({ timer }: { timer: TimerView }) {
  const { id, recipeId, recipeTitle, stepId, stepNumber, written, phase, paused } = timer;
  const named = `${written}, step ${stepNumber} of ${recipeTitle}`;
  const alarming = phase === "alarming";
  const row = useRef<HTMLLIElement>(null);
  const addMinute = useRef<HTMLButtonElement>(null);
  const pauseFocused = useRef(false);

  useLayoutEffect(() => reveal(row.current), []);

  // Pause goes when the alarm starts. React sees no blur from a removed control, so the flag still
  // holds, and focus goes on to +1 minute in place of dropping to the page.
  useLayoutEffect(() => {
    if (!alarming) return;
    reveal(row.current);
    if (pauseFocused.current) addMinute.current?.focus();
    pauseFocused.current = false;
  }, [alarming]);

  return (
    <li ref={row} className={`timer-row${PHASE_CLASS[phase]}`}>
      <Link
        className="timer-jump"
        to={{ pathname: recipePath({ id: recipeId, title: recipeTitle }), hash: `step-${stepId}` }}
      >
        <span className="timer-title">
          <span className="visually-hidden">Go to </span>
          {recipeTitle}
        </span>
        <span className="timer-step">
          Step {stepNumber} · {written}
        </span>
        <span className="timer-countdown">
          {paused && "Paused · "}
          {timer.countdown}
        </span>
      </Link>
      {!alarming && (
        <button
          type="button"
          className="icon-button"
          aria-label={`${paused ? "Resume" : "Pause"} ${named}`}
          onClick={() => (paused ? timers.resume(id) : timers.pause(id))}
          onFocus={() => {
            pauseFocused.current = true;
          }}
          onBlur={() => {
            pauseFocused.current = false;
          }}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
      )}
      <button
        ref={addMinute}
        type="button"
        className="icon-button timer-add"
        aria-label={`+1 minute on ${named}`}
        onClick={() => timers.addMinute(id)}
      >
        +1
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Cancel ${named}`}
        onClick={() => {
          timers.cancel(id);
          focusTitle();
        }}
      >
        <CloseIcon />
      </button>
    </li>
  );
}
