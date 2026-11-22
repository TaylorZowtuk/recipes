import { type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { adjustSummary } from "./AdjustSheet";
import { type AdjustChoices, lineView } from "./adjust";
import type { Recipe } from "./api/client";
import { openCookingMode } from "./cookingMode";
import { BackIcon, CloseIcon, ForwardIcon } from "./icons";
import { effective, type Version } from "./ourVersion";
import { stepNodes, TimerButton } from "./StepPieces";
import { stepText } from "./stepText";
import { stepTicks, useStepTicks } from "./stepTicks";
import { TimerDockHost } from "./TimerDock";
import { type ScreenStatus, useWakeLock } from "./wakeLock";

const TEXT_SIZE = "plateful.cookingTextSize";

function readLarge(): boolean {
  try {
    return localStorage.getItem(TEXT_SIZE) === "large";
  } catch {
    return false;
  }
}

function keepLarge(large: boolean) {
  try {
    if (large) localStorage.setItem(TEXT_SIZE, "large");
    else localStorage.removeItem(TEXT_SIZE);
  } catch {
    // Storage is a convenience: without it the size lasts while Cooking mode is open.
  }
}

const SCREEN: Record<ScreenStatus, string> = {
  asking: "Asking to keep the screen on…",
  on: "Screen stays on",
  off: "Screen may turn off",
};

export type Cooking = { recipe: Recipe; choices: AdjustChoices };

// The recipe page's Cook button, Resume once any of the steps of the `version` shown has a Step
// tick.
export function CookButton({
  recipe,
  version,
  opener,
  onCook,
}: {
  recipe: Recipe;
  version: Version;
  opener: RefObject<HTMLButtonElement | null>;
  onCook: () => void;
}) {
  const ticks = useStepTicks(recipe.id);
  const { steps } = effective(recipe, version).original;
  if (steps.length === 0) return null;
  return (
    <button
      ref={opener}
      type="button"
      className="button cook-open"
      aria-haspopup="dialog"
      onClick={onCook}
    >
      {steps.some((step) => ticks.has(step.id)) ? "Resume" : "Cook"}
    </button>
  );
}

// Cooking mode: the recipe full-screen, in the version its Adjust choices show, one step at a
// time, from the first without a Step tick. Next ticks the step it leaves; Finish ticks the last,
// clears the recipe's ticks and closes; Back and Close change no tick. It keeps the recipe and
// Adjust choices it opened with, whatever the page under it loads, until it closes, and focus then
// returns to `opener`, or to `fallback` when the page no longer shows it. The screen is kept on,
// running Timers show above Back and Next, and a Timer's link to one of its steps goes there.
export function CookingMode({
  recipe,
  choices,
  opener,
  fallback,
  onClose,
}: Cooking & {
  opener: RefObject<HTMLElement | null>;
  fallback: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const version = choices.version ?? "ours";
  const { original, facts } = useMemo(() => effective(recipe, version), [recipe, version]);
  const { steps, ingredients, title } = original;
  const [at, setAt] = useState(() => {
    const ticked = stepTicks.ticked(
      recipe.id,
      steps.map((step) => step.id),
    );
    return Math.max(
      steps.findIndex((step) => !ticked.has(step.id)),
      0,
    );
  });
  const [large, setLarge] = useState(readLarge);
  const screen = useWakeLock();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const adjusted = adjustSummary(choices);

  useEffect(() => {
    const release = openCookingMode();
    if (!dialog.current?.open) dialog.current?.showModal();
    heading.current?.focus();
    return () => {
      release();
      (opener.current ?? fallback.current)?.focus();
    };
  }, [opener, fallback]);

  // Only a navigation made while open moves it: the step in the address when it opened is old, and
  // so is the step in an address the page only corrected the slug of.
  const { hash, key, state } = useLocation();
  const shownKey = useRef(key);
  useEffect(() => {
    if (shownKey.current === key) return;
    shownKey.current = key;
    if (state?.slugFixed) return;
    const linked = steps.findIndex((step) => hash === `#step-${step.id}`);
    if (linked >= 0) setAt(linked);
  }, [key, hash, state, steps]);

  const step = steps[at];
  if (!step) return null;
  const number = at + 1;
  const last = number === steps.length;
  const uses = facts?.steps[step.id]?.uses?.uses ?? [];
  const next = () => {
    stepTicks.tick(recipe.id, step.id);
    if (!last) return setAt(at + 1);
    stepTicks.clear(recipe.id);
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      className={large ? "cooking cooking-large" : "cooking"}
      aria-labelledby={`${id}-title`}
      onClose={onClose}
    >
      <div className="cooking-top">
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
        <h2 ref={heading} id={`${id}-title`} className="cooking-title" tabIndex={-1}>
          {title}
        </h2>
        <button
          type="button"
          className="icon-button cooking-size"
          aria-pressed={large}
          onClick={() => {
            keepLarge(!large);
            setLarge(!large);
          }}
        >
          A+<span className="visually-hidden"> larger text</span>
        </button>
      </div>
      <div className="cooking-progress">
        <div className="cooking-progress-row">
          <p id={`${id}-progress`} className="cooking-progress-text">
            Step {number} of {steps.length}
          </p>
          {adjusted && <p className="cooking-adjusted">{adjusted}</p>}
          <p role="status" className="cooking-screen">
            {SCREEN[screen]}
          </p>
        </div>
        <progress max={steps.length} value={number} aria-labelledby={`${id}-progress`} />
      </div>
      <div className="cooking-body">
        {step.component && <p className="cooking-component">{step.component}</p>}
        <p className="cooking-step" aria-live="polite">
          <span className="visually-hidden">{`Step ${number} of ${steps.length}. `}</span>
          {stepNodes(stepText(step, facts, choices), (piece, n) => (
            <TimerButton
              key={n}
              recipeId={recipe.id}
              recipeTitle={title}
              step={step}
              number={number}
              piece={piece}
              n={n}
            />
          ))}
        </p>
        {uses.length > 0 && (
          <section className="cooking-uses" aria-labelledby={`${id}-uses`}>
            <h3 id={`${id}-uses`}>In this step</h3>
            <ul className="ingredients">
              {uses.map(({ ref, portion }) => {
                const line = facts.ingredients[ref];
                const parse = line?.parse;
                return (
                  <li key={ref}>
                    <span className="ingredient-name">
                      {parse?.name ?? ingredients.find((i) => i.id === ref)?.text}
                    </span>
                    {line && parse?.quantity && (
                      <>
                        {" "}
                        <span className="ingredient-amount">
                          {lineView(line, choices, choices.taps?.[ref], portion).amount}
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
      <TimerDockHost />
      <div className="cooking-nav">
        <button
          type="button"
          className="button button-secondary"
          aria-disabled={at === 0}
          onClick={() => at > 0 && setAt(at - 1)}
        >
          <BackIcon />
          Back
        </button>
        <button type="button" className="button" onClick={next}>
          {last ? "Finish" : "Next"}
          {!last && <ForwardIcon />}
        </button>
      </div>
    </dialog>
  );
}
