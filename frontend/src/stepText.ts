import { type AdjustChoices, lineView, temperature } from "./adjust";
import type { RecipeFacts, Step, StepFacts } from "./api/client";

type Segment = NonNullable<StepFacts["segments"]>["segments"][number];

export type DurationPiece = Extract<Segment, { t: "duration" }>;

// A run of a step's text, an ingredient's amount and the name it goes before, or a duration.
export type StepPiece = string | { amount: string; name: string } | DurationPiece;

// A step's text for display with the Adjust choices. Where it names an ingredient line with an
// amount, it shows that line's amount × the portion that mention uses × the scale, in the line's
// tapped unit or the unit system's, then the line's short name. A temperature shows in the unit
// system, a duration stays its segment, and every other piece stays as written. A step without
// segments, or a recipe not yet enriched, is its raw text.
export function stepText(
  step: Step,
  facts: RecipeFacts | undefined,
  choices: AdjustChoices,
): StepPiece[] {
  const stepFacts = facts?.steps[step.id];
  if (!facts || !stepFacts?.segments) return [step.text];
  return stepFacts.segments.segments.map((segment) => {
    if (segment.t === "text") return segment.v;
    if (segment.t === "duration") return segment;
    if (segment.t === "temperature") return temperature(segment, choices.units);
    const line = facts.ingredients[segment.ref];
    if (!line?.parse?.quantity) return segment.written;
    const { amount } = lineView(line, choices, choices.taps?.[segment.ref], segment.portion);
    return { amount, name: line.parse.short_name ?? line.parse.name };
  });
}
