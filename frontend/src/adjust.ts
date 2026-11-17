import { decimal, FRACTIONS, formatAmount } from "./amount";
import type { ConversionFact, Factor, IngredientFacts, StepFacts } from "./api/client";

// The Confidence Threshold: a volume or count shows as a weight only when its conversion is
// confirmed with at least this confidence.
export const CONFIDENCE_THRESHOLD = 0.8;

// The unit system a recipe shows its amounts and temperatures in.
export type Units = "written" | "metric" | "us";
// One ingredient's unit, chosen by a tap: a unit system, or a weight (≈ g or ≈ oz) its conversion
// gives a volume or count.
export type UnitChoice = Units | "g" | "oz";

// The Adjust choices: a scale, a unit system and each tapped line's unit, by ingredient ref.
export type AdjustChoices = { scale: Factor; units: Units; taps?: Record<string, UnitChoice> };
export const AS_WRITTEN: AdjustChoices = { scale: 1, units: "written" };

type Line = IngredientFacts;
type Segment = NonNullable<StepFacts["segments"]>["segments"][number];
type TemperatureSegment = Extract<Segment, { t: "temperature" }>;
type Range = [number, number];
type Measure = { kind: "mass" | "volume"; base: number; metric: boolean };

// The refusal an editor's "keep in the written unit" stores (backend EDITOR_KEPT).
const EDITOR_KEPT = "kept in the written unit by an editor";
export const KEPT = "An editor kept this in the written unit";
export const UNCHECKED = "This conversion hasn't been checked yet";
export const NO_WEIGHT = "No weight known for this ingredient yet";

const TSP = 4.92892159375;
const TBSP = 3 * TSP;
const CUP = 16 * TBSP;
const OZ = 28.349523125;
const LB = 16 * OZ;

// Each unit as the parser writes it (pint's short symbols) or an editor spells it, in g or ml.
const MEASURES = new Map<string, Measure>();
const add = (kind: Measure["kind"], names: string, base: number, metric: boolean) => {
  for (const name of names.split("|")) MEASURES.set(name, { kind, base, metric });
};
add("mass", "g|gram|grams", 1, true);
add("mass", "kg|kilogram|kilograms", 1000, true);
add("mass", "mg|milligram|milligrams", 0.001, true);
add("mass", "oz|ounce|ounces", OZ, false);
add("mass", "lb|lbs|pound|pounds", LB, false);
add("volume", "ml|milliliter|milliliters|millilitre|millilitres|cc|cm3", 1, true);
add("volume", "cl|centiliter|centiliters|centilitre|centilitres", 10, true);
add("volume", "dl|deciliter|deciliters|decilitre|decilitres", 100, true);
add("volume", "l|liter|liters|litre|litres", 1000, true);
add("volume", "tsp|teaspoon|teaspoons", TSP, false);
add("volume", "tbsp|tablespoon|tablespoons", TBSP, false);
add("volume", "cup|cups", CUP, false);
add("volume", "floz|fl oz|fl", CUP / 8, false);
add("volume", "pt|pint|pints", 2 * CUP, false);
add("volume", "qt|quart|quarts", 4 * CUP, false);
add("volume", "gal|gallon|gallons", 16 * CUP, false);

const measure = (unit: string | null) => MEASURES.get((unit ?? "").trim().toLowerCase());

// The kitchen measures a tidied volume shows in, largest first.
const SPOONS_AND_CUPS: [number, string][] = [
  [CUP, "cup"],
  [TBSP, "tbsp"],
  [TSP, "tsp"],
];
const SPOONS = SPOONS_AND_CUPS.slice(1);
const inSet = (m: Measure | undefined, set: [number, string][]) =>
  !!m && !m.metric && set.some(([size]) => size === m.base);

// An amount in grams, as metric (g, kg from 1000 g) or US (oz, lb from 16 oz).
function metric(values: Range, small: string, large: string): string {
  const whole = values.map(Math.round) as Range;
  if (whole[1] >= 1000)
    return decimals(
      values.map((v) => decimal(v / 1000)),
      large,
    );
  return decimals(whole.map(String), small);
}

function us(grams: Range): string {
  const oz = grams.map((g) => eighths(g / OZ)) as Range;
  if (oz[1] >= 16) return fractions(grams.map((g) => eighths(g / LB)) as Range, "lb");
  return fractions(oz, "oz");
}

// An amount already in a metric unit, in g or ml (or kg or l from 1000): whole from 10, else a
// decimal, as a kitchen scale or jug reads, never a kitchen fraction.
function metricAsDecimals(values: Range, small: string, large: string): string {
  if (values[1] >= 1000)
    return decimals(
      values.map((v) => decimal(v / 1000)),
      large,
    );
  return decimals(
    values.map((v) => (v >= 10 ? String(Math.round(v)) : decimal(v))),
    small,
  );
}

const decimals = ([low, high]: string[], unit: string) =>
  `${low === high ? low : `${low}–${high}`} ${unit}`;
const fractions = ([low, high]: Range, unit: string | null) => formatAmount({ low, high }, unit);
// To the nearest ⅛, and never less than ⅛.
const eighths = (value: number) => Math.max(Math.round(value * 8) / 8, 1 / 8);

function isKitchen(value: number): boolean {
  const rest = value - Math.floor(value);
  return rest < 0.01 || rest > 0.99 || FRACTIONS.some(([part]) => Math.abs(rest - part) < 0.01);
}

// A volume in ml tidied to the friendliest kitchen measure: the largest of `set` in which both
// ends are a whole number or a kitchen fraction, never under ¼ cup or 1 tbsp. When none is, or
// the volume was converted from ml (`converted`), the largest that clears those minimums, to the
// nearest ⅛.
function tidy(ml: Range, set: [number, string][], converted = false): string {
  const usable = set.filter(
    ([size], i) => i === set.length - 1 || ml[0] / size >= (size === CUP ? 1 / 4 : 1),
  );
  const exact = converted
    ? undefined
    : usable.find(([size]) => ml.every((v) => isKitchen(v / size)));
  const [size, unit] = exact ?? usable[0] ?? [TSP, "tsp"];
  return fractions(ml.map((v) => (exact ? v / size : eighths(v / size))) as Range, unit);
}

const trusted = (c: ConversionFact) =>
  c.confirmed && c.confidence >= CONFIDENCE_THRESHOLD && !c.refused;

const singular = (unit: string) =>
  unit
    .toLowerCase()
    .replace(/\(e?s\)/, "")
    .replace(/ies$/, "y")
    .replace(/s$/, "")
    .trim();

// Grams per one of the line's written unit that its conversion gives a volume or count, checked
// or not. A line with no unit counts in any count unit, as the API decided when it chose it.
function gramsPerUnit(line: Line): number | undefined {
  const { parse, conversion: c } = line;
  if (!parse || !c) return undefined;
  const m = measure(parse.unit);
  if (m) return m.kind === "volume" && c.density_g_per_ml ? c.density_g_per_ml * m.base : undefined;
  if (parse.unit_kind === "mass" || parse.unit_kind === "volume") return undefined;
  const counts = !parse.unit || (!!c.count_unit && singular(c.count_unit) === singular(parse.unit));
  return counts && c.grams_per_count ? c.grams_per_count : undefined;
}

const weighs = (line: Line) =>
  !!line.conversion && trusted(line.conversion) && !!gramsPerUnit(line);

// Why a volume or count line offers no weight, or undefined when it does or is a weight already.
export function weightRefusal(line: Line): string | undefined {
  const { parse, conversion: c } = line;
  if (!parse || measure(parse.unit)?.kind === "mass" || parse.unit_kind === "mass")
    return undefined;
  if (weighs(line)) return undefined;
  if (c?.refused === EDITOR_KEPT) return KEPT;
  if (c && !c.refused && gramsPerUnit(line)) return UNCHECKED;
  return NO_WEIGHT;
}

function render(line: Line, choice: UnitChoice, scale: number, portion: number): string {
  const parse = line.parse;
  if (!parse) return "";
  if (!parse.quantity) return parse.unit ?? "";
  const q: Range = [parse.quantity.low * scale * portion, parse.quantity.high * scale * portion];
  const m = measure(parse.unit);
  const base = (per: number) => q.map((v) => v * per) as Range;
  if (choice === "g" || choice === "oz") {
    const grams = base(gramsPerUnit(line) ?? 0);
    return `≈ ${choice === "g" ? metric(grams, "g", "kg") : us(grams)}`;
  }
  if (m && choice === "metric" && !m.metric) {
    if (m.kind === "mass") return metric(base(m.base), "g", "kg");
    if (!inSet(m, SPOONS)) return metric(base(m.base), "ml", "l");
    if (scale !== 1) return tidy(base(m.base), SPOONS);
  }
  if (m && choice === "metric" && m.metric && m.base >= 1) {
    return m.kind === "mass"
      ? metricAsDecimals(base(m.base), "g", "kg")
      : metricAsDecimals(base(m.base), "ml", "l");
  }
  if (m && choice === "us" && m.metric) {
    return m.kind === "mass" ? us(base(m.base)) : tidy(base(m.base), SPOONS_AND_CUPS, true);
  }
  if (m && choice === "us" && m.base === OZ && q[1] >= 16) return us(base(m.base));
  if (m && scale !== 1 && inSet(m, SPOONS_AND_CUPS)) return tidy(base(m.base), SPOONS_AND_CUPS);
  return fractions(q, parse.unit);
}

// The units a line can honestly take, in the order a tap cycles them: the unit system's, the
// other system's where it shows differently, then ≈ g and ≈ oz when its conversion clears the
// Confidence Threshold. One option means a tap changes nothing.
export function unitOptions(
  line: Line,
  { scale, units }: AdjustChoices,
): [UnitChoice, ...UnitChoice[]] {
  const parse = line.parse;
  if (!parse?.quantity) return [units];
  const metricUnit = measure(parse.unit)?.metric;
  const other = units === "metric" || (units === "written" && metricUnit) ? "us" : "metric";
  const options: [UnitChoice, ...UnitChoice[]] = [units];
  if (render(line, other, scale, 1) !== render(line, units, scale, 1)) options.push(other);
  if (weighs(line)) options.push("g", "oz");
  return options;
}

// The unit a tap moves a line to from `current` (the unit system's when none), wrapping round.
export function nextUnit(line: Line, choices: AdjustChoices, current?: UnitChoice): UnitChoice {
  const options = unitOptions(line, choices);
  return options[(options.indexOf(current ?? options[0]) + 1) % options.length] ?? options[0];
}

// A line's amount × `portion` (a step's share of it) × the scale, in the tapped unit if the line
// still offers it, else the unit system's. A line with no amount is its unit, or nothing.
export function lineAmount(
  line: Line,
  choices: AdjustChoices,
  tap?: UnitChoice,
  portion = 1,
): string {
  const options = unitOptions(line, choices);
  const choice = tap && options.includes(tap) ? tap : options[0];
  return render(line, choice, choices.scale, portion);
}

// A step's temperature as written when it's already in the unit system's scale (an F scale is
// °F, any other °C, as the API reads it), else converted to the nearest 5, as an oven dial reads.
export function temperature({ c, written }: TemperatureSegment, units: Units): string {
  const nearest5 = (value: number) => Math.round(value / 5) * 5;
  const fahrenheit = /f/i.test(written);
  if (units === "metric" && fahrenheit) return `${nearest5(c)}°C`;
  if (units === "us" && !fahrenheit) return `${nearest5((c * 9) / 5 + 32)}°F`;
  return written;
}
