import { useId, useRef, useState } from "react";
import type { AdjustChoices, Units } from "./adjust";
import type { Factor } from "./api/client";
import type { Version } from "./ourVersion";
import { Sheet } from "./Sheet";
import { SCALES, scaleLabel } from "./weekPlan";

const UNITS: [Units, string][] = [
  ["written", "As written"],
  ["metric", "Metric"],
  ["us", "US"],
];

const VERSIONS: [Version, string][] = [
  ["ours", "Our Version"],
  ["original", "Original"],
];

// The Adjust choices shown on the button, and in Cooking mode, when they differ from Our Version
// as written at 1×, as "2× · Metric · Original".
export function adjustSummary({ scale, units, version }: AdjustChoices): string {
  return [
    scale !== 1 && scaleLabel(scale),
    units !== "written" && UNITS.find(([u]) => u === units)?.[1],
    version === "original" && "Original",
  ]
    .filter(Boolean)
    .join(" · ");
}

// The recipe page's Adjust button and its sheet: a scale and a unit system for this recipe, on
// this device only, and for a recipe with Our Version, which version shows. A new unit system or
// version clears the ingredients' own tapped units. A Pending recipe has no Facts to scale or
// convert, so there the button is disabled with a note saying why.
export function AdjustButton({
  choices,
  onChange,
  pending,
  ourVersion = false,
}: {
  choices: AdjustChoices;
  onChange: (choices: AdjustChoices) => void;
  pending: boolean;
  ourVersion?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const noteId = useId();
  const summary = adjustSummary(choices);
  if (pending)
    return (
      <div className="adjust-pending">
        <button
          type="button"
          className="button button-secondary adjust-open"
          disabled
          aria-describedby={noteId}
        >
          Adjust
        </button>
        <p id={noteId} className="adjust-note">
          Scaling and units are ready once this recipe is enriched
        </p>
      </div>
    );
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
          onChoose={(units) =>
            units !== choices.units &&
            onChange({ scale: choices.scale, units, version: choices.version })
          }
        />
        {ourVersion && (
          <ChoiceGroup
            label="Version"
            options={VERSIONS}
            current={choices.version ?? "ours"}
            onChoose={(version) =>
              version !== (choices.version ?? "ours") &&
              onChange({ scale: choices.scale, units: choices.units, version })
            }
          />
        )}
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
