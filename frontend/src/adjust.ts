import { decimal, FRACTIONS, formatAmount } from "./amount";
import type { ConversionFact, Factor, IngredientFacts, StepFacts } from "./api/client";
import { EDITOR_KEPT } from "./factEdits";

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

const METRIC = { mass: ["g", "kg"], volume: ["ml", "l"] } as const;

// An amount in g or ml, as kg or l from 1000: whole from 10, else a decimal, as a kitchen scale or
// jug reads, never a fraction. Under 10, one written in a metric unit (`exact`) keeps two places
// and a converted one shows one.
function inMetric(values: Range, kind: Measure["kind"], exact: boolean): string {
  const [small, large] = METRIC[kind];
  if (Math.round(values[1]) >= 1000)
    return decimals(
      values.map((v) => decimal(v / 1000)),
      large,
    );
  const underTen = (v: number) => (exact ? decimal(v) : String(Math.round(v * 10) / 10));
  return decimals(
    values.map((v) => (v < 10 ? underTen(v) : String(Math.round(v)))),
    small,
  );
}

// An amount in grams in US weights: oz, or lb from 16 oz. One that rounds below ⅛ oz at its high
// end is "under ⅛ oz"; else neither end shows under ⅛.
function us(grams: Range): string {
  if (Math.round((grams[1] / OZ) * 8) === 0) return "under ⅛ oz";
  const oz = grams.map((g) => eighths(g / OZ)) as Range;
  if (oz[1] >= 16) return fractions(grams.map((g) => eighths(g / LB)) as Range, "lb");
  return fractions(oz, "oz");
}

const decimals = ([low, high]: string[], unit: string) =>
  `${low === high ? low : `${low}–${high}`} ${unit}`;
const fractions = ([low, high]: Range, unit: string | null) => formatAmount({ low, high }, unit);
// To the nearest ⅛, and never less than ⅛.
const eighths = (value: number) => Math.max(Math.round(value * 8) / 8, 1 / 8);

// The fractions a kitchen measures in: any ⅛ of a spoon, but only ¼, ⅓, ½, ⅔ or ¾ of a cup.
const CUP_PARTS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];
function isKitchen(value: number, size: number): boolean {
  const rest = value - Math.floor(value);
  const parts = size === CUP ? CUP_PARTS : FRACTIONS.map(([part]) => part);
  return rest < 0.01 || rest > 0.99 || parts.some((part) => Math.abs(rest - part) < 0.01);
}

// A number of cups to the nearest cup part or whole cup, and never less than ¼; of a spoon, to
// the nearest ⅛.
function toKitchen(value: number, size: number): number {
  if (size !== CUP) return eighths(value);
  const whole = Math.floor(value);
  const part = [0, ...CUP_PARTS, 1].reduce((best, p) =>
    Math.abs(value - whole - p) < Math.abs(value - whole - best) ? p : best,
  );
  return Math.max(whole + part, 1 / 4);
}

// A volume in ml in one kitchen unit of `set`: a spoon fits from 1 of it with a low end of ⅛ (tsp
// always) but carries at most 1 cup when `set` has cups; cups fit from ¼ with a low end of ⅛, or
// past 1 cup. The largest fitting unit exact in kitchen fractions wins (unless `converted`), else
// the largest fitting unit, rounded.
function tidy(ml: Range, set: [number, string][], converted = false): string {
  const cups = set.some(([size]) => size === CUP);
  const fits = set.filter(([size]) => {
    if (size === CUP) return (ml[1] >= CUP / 4 && ml[0] >= CUP / 8) || ml[1] > CUP;
    if (cups && ml[1] > CUP) return false;
    return size === TSP || (ml[1] >= size && ml[0] >= size / 8);
  });
  if (!converted) {
    for (const [size, unit] of fits) {
      const values = ml.map((v) => v / size) as Range;
      if (values.every((v) => isKitchen(v, size))) return fractions(values, unit);
    }
  }
  const [size, unit] = fits[0] as [number, string];
  return fractions(ml.map((v) => toKitchen(v / size, size)) as Range, unit);
}

const trusted = (c: ConversionFact) =>
  c.confirmed && c.confidence >= CONFIDENCE_THRESHOLD && !c.refused;

// Whether a portion counted in `countUnit` counts in a line's unit, ignoring case and plurals: a
// line with no unit fits only a bare count ("large" egg). Mirrors the API's fdc._counts_in.
const BARE_COUNTS = new Set([
  "each",
  "piece",
  "unit",
  "item",
  "small",
  "medium",
  "large",
  "extra large",
  "jumbo",
]);
const words = (text: string) =>
  new Set(
    (text.toLowerCase().match(/[a-z]+/g) ?? []).map((word) =>
      word.replace(/(?<=..)ies$/, "y").replace(/(?<=...)(?<!s)s$/, ""),
    ),
  );
function countsIn(countUnit: string | null, unit: string | null): boolean {
  if (!countUnit) return false;
  if (!unit) return BARE_COUNTS.has(countUnit);
  const [a, b] = [words(countUnit), words(unit.replace(/\((?:e?s)\)/i, ""))];
  return a.size === b.size && [...a].every((word) => b.has(word));
}

// Grams per one of the line's written unit that its conversion gives a volume or count, checked
// or not.
function gramsPerUnit(line: Line): number | undefined {
  const { parse, conversion: c } = line;
  if (!parse || !c) return undefined;
  const m = measure(parse.unit);
  if (m) return m.kind === "volume" && c.density_g_per_ml ? c.density_g_per_ml * m.base : undefined;
  if (parse.unit_kind === "mass" || parse.unit_kind === "volume") return undefined;
  return countsIn(c.count_unit, parse.unit) && c.grams_per_count ? c.grams_per_count : undefined;
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
    return `≈ ${choice === "g" ? inMetric(grams, "mass", false) : us(grams)}`;
  }
  if (m && choice === "metric" && !m.metric) {
    if (!inSet(m, SPOONS)) return inMetric(base(m.base), m.kind, false);
    if (scale !== 1) return tidy(base(m.base), SPOONS);
  }
  if (m?.metric && m.base >= 1 && (choice === "metric" || (choice === "written" && scale !== 1)))
    return inMetric(base(m.base), m.kind, true);
  if (m && choice === "us" && m.metric) {
    return m.kind === "mass" ? us(base(m.base)) : tidy(base(m.base), SPOONS_AND_CUPS, true);
  }
  if (m && choice === "us" && m.base === OZ && q[1] >= 16) return us(base(m.base));
  if (m && scale !== 1 && inSet(m, SPOONS_AND_CUPS)) return tidy(base(m.base), SPOONS_AND_CUPS);
  return fractions(q, m || scale === 1 ? parse.unit : counted(parse.unit, q[1]));
}

// A count unit made plural or singular as `amount` is, by one trailing "s".
function counted(unit: string | null, amount: number): string | null {
  if (!unit) return unit;
  if (amount > 1) return unit.endsWith("s") ? unit : `${unit}s`;
  return unit.endsWith("s") ? unit.slice(0, -1) : unit;
}

// The units a line can honestly take, in the order a tap cycles them: the unit system's, the
// other system's where it shows differently, then ≈ g and ≈ oz when its conversion clears the
// Confidence Threshold.
function unitOptions(line: Line, { scale, units }: AdjustChoices): [UnitChoice, ...UnitChoice[]] {
  const parse = line.parse;
  if (!parse?.quantity) return [units];
  const metricUnit = measure(parse.unit)?.metric;
  const other = units === "metric" || (units === "written" && metricUnit) ? "us" : "metric";
  const options: [UnitChoice, ...UnitChoice[]] = [units];
  if (render(line, other, scale, 1) !== render(line, units, scale, 1)) options.push(other);
  if (weighs(line)) options.push("g", "oz");
  return options;
}

// A line's amount × `portion` (a step's share of it) × the scale, in the tapped unit if the line
// still offers it, else the unit system's; the unit a tap moves it to, when it has another; and
// why it can't be a weight, when it can't. A line with no amount is its unit, or nothing.
export type LineView = { amount: string; next?: UnitChoice; reason?: string };
export function lineView(
  line: Line,
  choices: AdjustChoices,
  tap?: UnitChoice,
  portion = 1,
): LineView {
  const options = unitOptions(line, choices);
  const at = Math.max(tap ? options.indexOf(tap) : 0, 0);
  const view: LineView = {
    amount: render(line, options[at] ?? options[0], choices.scale, portion),
  };
  if (options.length > 1) view.next = options[(at + 1) % options.length];
  const reason = weightRefusal(line);
  if (reason) view.reason = reason;
  return view;
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
