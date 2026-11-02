import type { Quantity } from "./api/client";

const FRACTIONS: [number, string][] = [
  [1 / 8, "⅛"],
  [1 / 4, "¼"],
  [1 / 3, "⅓"],
  [3 / 8, "⅜"],
  [1 / 2, "½"],
  [5 / 8, "⅝"],
  [2 / 3, "⅔"],
  [3 / 4, "¾"],
  [7 / 8, "⅞"],
];

// A quantity for display, with kitchen fractions where one fits and an en dash between a range's
// ends. Anything else stays a decimal of at most two places.
export function formatQuantity({ low, high }: Quantity): string {
  return low === high ? kitchenNumber(low) : `${kitchenNumber(low)}–${kitchenNumber(high)}`;
}

// An amount for display. Units are stored as pint's symbols, which are singular, and of those
// only "cup" is a word that takes a plural.
export function formatAmount(quantity: Quantity, unit: string | null): string {
  const shown = unit === "cup" && quantity.high > 1 ? "cups" : unit;
  return [formatQuantity(quantity), shown].filter(Boolean).join(" ");
}

function kitchenNumber(value: number): string {
  const whole = Math.floor(value);
  const rest = value - whole;
  if (rest < 0.01) return String(whole);
  const fraction = FRACTIONS.find(([part]) => Math.abs(rest - part) < 0.01);
  if (fraction) return `${whole || ""}${fraction[1]}`;
  return String(Math.round(value * 100) / 100);
}
