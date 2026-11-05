import { useEffect, useRef } from "react";
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

function TimerRow({ timer }: { timer: TimerView }) {
  const { id, recipeId, recipeTitle, stepId, stepNumber, written, phase, paused } = timer;
  const named = `${written}, step ${stepNumber} of ${recipeTitle}`;
  return (
    <li className={`timer-row${PHASE_CLASS[phase]}`}>
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
      {phase !== "alarming" && (
        <button
          type="button"
          className="icon-button"
          aria-label={`${paused ? "Resume" : "Pause"} ${named}`}
          onClick={() => (paused ? timers.resume(id) : timers.pause(id))}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
      )}
      <button
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
