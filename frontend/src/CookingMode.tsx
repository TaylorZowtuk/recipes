import { useEffect, useId, useRef, useState } from "react";
import { type AdjustChoices, lineView } from "./adjust";
import type { Recipe } from "./api/client";
import { setCookingModeOpen } from "./cookingMode";
import { BackIcon, CloseIcon, ForwardIcon } from "./icons";
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

type Cooking = { recipe: Recipe; choices: AdjustChoices };

// The recipe page's Cook button, Resume once any of the recipe's steps has a Step tick. It opens
// Cooking mode with the recipe and Adjust choices as they are, which hold until it closes; focus
// then returns here.
export function CookButton({ recipe, choices }: Cooking) {
  const ticks = useStepTicks(recipe.id);
  const [cooking, setCooking] = useState<Cooking | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const closed = useRef(false);

  useEffect(() => {
    if (cooking || !closed.current) return;
    closed.current = false;
    opener.current?.focus();
  }, [cooking]);

  const { steps } = recipe.original;
  if (steps.length === 0) return null;
  return (
    <>
      <button
        ref={opener}
        type="button"
        className="button cook-open"
        aria-haspopup="dialog"
        onClick={() => setCooking({ recipe, choices })}
      >
        {steps.some((step) => ticks.has(step.id)) ? "Resume" : "Cook"}
      </button>
      {cooking && (
        <CookingMode
          {...cooking}
          onClose={() => {
            closed.current = true;
            setCooking(null);
          }}
        />
      )}
    </>
  );
}

// Cooking mode: the recipe full-screen, one step at a time, from the first without a Step tick.
// Next ticks the step it leaves; Finish ticks the last, clears the recipe's ticks and closes; Back
// and Close change no tick. The screen is kept on, and running Timers show above Back and Next.
function CookingMode({ recipe, choices, onClose }: Cooking & { onClose: () => void }) {
  const { steps, ingredients, title } = recipe.original;
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

  useEffect(() => {
    setCookingModeOpen(true);
    if (!dialog.current?.open) dialog.current?.showModal();
    heading.current?.focus();
    return () => setCookingModeOpen(false);
  }, []);

  const step = steps[at];
  if (!step) return null;
  const number = at + 1;
  const last = number === steps.length;
  const uses = recipe.facts?.steps[step.id]?.uses?.uses ?? [];
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
          aria-label="Larger text"
          aria-pressed={large}
          onClick={() => {
            keepLarge(!large);
            setLarge(!large);
          }}
        >
          A+
        </button>
      </div>
      <div className="cooking-progress">
        <p id={`${id}-progress`} className="cooking-progress-text">
          Step {number} of {steps.length}
        </p>
        <progress max={steps.length} value={number} aria-labelledby={`${id}-progress`} />
      </div>
      <div className="cooking-body">
        {step.component && <p className="cooking-component">{step.component}</p>}
        <p className="cooking-step" aria-live="polite">
          {stepNodes(stepText(step, recipe.facts, choices), (piece, n) => (
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
                const line = recipe.facts.ingredients[ref];
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
        <p role="status" className="cooking-screen">
          {SCREEN[screen]}
        </p>
      </div>
      <TimerDockHost />
      <div className="cooking-nav">
        <button
          type="button"
          className="button button-secondary"
          disabled={at === 0}
          onClick={() => setAt(at - 1)}
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
