import { formatAmount } from "./amount";
import type { RecipeFacts, Step } from "./api/client";

// A run of a step's text, or an ingredient's amount and the name it goes before.
export type StepPiece = string | { amount: string; name: string };

// A step's text for display at a scale. Where it names an ingredient line with an amount, it shows
// that line's amount × the portion that mention uses × the scale, then the line's short name. Every
// other piece stays as written, and a step without segments, or a recipe not yet enriched, is its
// raw text.
export function stepText(step: Step, facts: RecipeFacts | undefined, scale: number): StepPiece[] {
  const stepFacts = facts?.steps[step.id];
  if (!facts || !stepFacts?.segments) return [step.text];
  return stepFacts.segments.segments.map((segment) => {
    if (segment.t === "text") return segment.v;
    if (segment.t !== "ingredient") return segment.written;
    const parse = facts.ingredients[segment.ref]?.parse;
    if (!parse?.quantity) return segment.written;
    const factor = segment.portion * scale;
    const quantity = { low: parse.quantity.low * factor, high: parse.quantity.high * factor };
    return { amount: formatAmount(quantity, parse.unit), name: parse.short_name ?? parse.name };
  });
}
