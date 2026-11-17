import { useRef, useState } from "react";
import type { AdjustChoices, Units } from "./adjust";
import type { Factor } from "./api/client";
import { Sheet } from "./Sheet";
import { SCALES, scaleLabel } from "./weekPlan";

const UNITS: [Units, string][] = [
  ["written", "As written"],
  ["metric", "Metric"],
  ["us", "US"],
];

// The Adjust choices shown on the button when they differ from as written at 1×, as "2× · Metric".
function adjustSummary({ scale, units }: AdjustChoices): string {
  return [
    scale !== 1 && scaleLabel(scale),
    units !== "written" && UNITS.find(([u]) => u === units)?.[1],
  ]
    .filter(Boolean)
    .join(" · ");
}

// The recipe page's Adjust button and its sheet: a scale and a unit system for this recipe, on
// this device only. A new unit system clears the ingredients' own tapped units.
export function AdjustButton({
  choices,
  onChange,
}: {
  choices: AdjustChoices;
  onChange: (choices: AdjustChoices) => void;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const summary = adjustSummary(choices);
  return (
    <>
      <button
        ref={opener}
        type="button"
        className="button button-secondary adjust-open"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {summary ? `Adjust · ${summary}` : "Adjust"}
      </button>
      <Sheet
        open={open}
        title="Adjust"
        onClose={() => {
          setOpen(false);
          opener.current?.focus();
        }}
      >
        <ChoiceGroup
          label="Scale"
          options={SCALES.map((factor): [Factor, string] => [factor, scaleLabel(factor)])}
          current={choices.scale}
          onChoose={(scale) => onChange({ ...choices, scale })}
        />
        <ChoiceGroup
          label="Units"
          options={UNITS}
          current={choices.units}
          onChoose={(units) => units !== choices.units && onChange({ scale: choices.scale, units })}
        />
        <div className="sheet-actions">
          <button type="button" className="button" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      </Sheet>
    </>
  );
}

function ChoiceGroup<T extends string | number>({
  label,
  options,
  current,
  onChoose,
}: {
  label: string;
  options: [T, string][];
  current: T;
  onChoose: (value: T) => void;
}) {
  return (
    <fieldset className="sheet-section">
      <legend>{label}</legend>
      <ul className="chips chips-wrap">
        {options.map(([value, text]) => (
          <li key={value}>
            <button
              type="button"
              className="chip"
              aria-pressed={value === current}
              onClick={() => onChoose(value)}
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
