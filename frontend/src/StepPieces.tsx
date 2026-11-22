import { Fragment, type ReactNode } from "react";
import type { Step } from "./api/client";
import type { DurationPiece, StepPiece } from "./stepText";
import { timers } from "./timers";

// A step's pieces as shown, on the recipe page and in Cooking mode: an amount marked so it can be
// told apart, before the ingredient's name, and a duration as `duration` shows it.
export function stepNodes(
  pieces: StepPiece[],
  duration: (piece: DurationPiece, n: number) => ReactNode,
): ReactNode[] {
  return pieces.map((piece, n) => {
    if (typeof piece === "string") return piece;
    if ("t" in piece) return duration(piece, n);
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: a step's pieces never reorder.
      <Fragment key={n}>
        <span className="step-amount">{piece.amount}</span> {piece.name}
      </Fragment>
    );
  });
}

// The button that starts a duration's Timer, the `n`th piece of step `number` of the recipe.
export function TimerButton({
  recipeId,
  recipeTitle,
  step,
  number,
  piece,
  n,
}: {
  recipeId: string;
  recipeTitle: string;
  step: Step;
  number: number;
  piece: DurationPiece;
  n: number;
}) {
  return (
    <button
      type="button"
      className="step-timer"
      aria-label={`Start a timer for ${piece.written}`}
      onClick={() =>
        timers.start({
          recipeId,
          recipeTitle,
          stepId: step.id,
          stepNumber: number,
          position: n,
          written: piece.written,
          lowS: piece.low_s,
          highS: piece.high_s,
        })
      }
    >
      {piece.written}
    </button>
  );
}
