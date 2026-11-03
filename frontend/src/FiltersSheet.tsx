import { useId, useRef, useState } from "react";
import { activeFilterCount, type CardFilters, isChosen, noFilters, toggleTag } from "./cardFilters";
import { Sheet } from "./Sheet";
import { formatStatedTime } from "./statedTime";
import { TagChip } from "./TagList";

const DIFFICULTIES: [number | null, string][] = [
  [null, "Any"],
  [4, "4"],
  [5, "5"],
  [6, "6"],
  [7, "7"],
];
const TIMES: [number | null, string][] = [
  [null, "Any"],
  ...[900, 1800, 2700, 3600, 7200].map((s): [number, string] => [s, formatStatedTime(s) ?? ""]),
];

// In Difficulty's order. The pill shows the part; its name says what ticking it means.
const EASY_PARTS: ["easyPrep" | "easyCook" | "easyCleanup", string][] = [
  ["easyPrep", "Prep"],
  ["easyCook", "Cook"],
  ["easyCleanup", "Cleanup"],
];

const matchCount = (shown: number) =>
  shown === 0 ? "No recipes match" : `Show ${shown} ${shown === 1 ? "recipe" : "recipes"}`;

type SheetProps = {
  tags: string[];
  filters: CardFilters;
  shown: number;
  onChange: (filters: CardFilters) => void;
};

// The Filters button and the sheet it opens, a modal dialog. Every change applies at once; Clear
// empties every filter and Done, Escape or a tap outside it closes it, returning focus to the
// button. The sheet covers the status line, so Done and a status inside it say how many match.
export function FiltersSheet({ tags, filters, shown, onChange }: SheetProps) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const active = activeFilterCount(filters);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="button button-secondary"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {active > 0 ? `Filters · ${active}` : "Filters"}
      </button>
      <Sheet
        open={open}
        title="Filters"
        onClose={() => {
          setOpen(false);
          button.current?.focus();
        }}
      >
        {tags.length > 0 && (
          <section className="sheet-section" aria-labelledby={`${id}-tags`}>
            <h3 id={`${id}-tags`}>Tags</h3>
            <ul className="chips chips-wrap" aria-labelledby={`${id}-tags`}>
              {tags.map((tag) => (
                <li key={tag}>
                  <TagChip
                    tag={tag}
                    pressed={isChosen(filters, tag)}
                    onToggle={() => onChange(toggleTag(filters, tag))}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
        <Choices
          label="Total Difficulty at most"
          name={`${id}-difficulty`}
          options={DIFFICULTIES}
          value={filters.maxTotalDifficulty}
          onChange={(maxTotalDifficulty) => onChange({ ...filters, maxTotalDifficulty })}
        />
        <fieldset className="sheet-section easy-parts" aria-describedby={`${id}-easy`}>
          <legend>Easy</legend>
          <p id={`${id}-easy`} className="field-hint">
            Rated 1 of 3
          </p>
          <div className="choices">
            {EASY_PARTS.map(([key, part]) => (
              <label key={key} className="choice">
                <input
                  type="checkbox"
                  className="visually-hidden"
                  aria-label={`Easy ${part.toLowerCase()}`}
                  checked={filters[key]}
                  onChange={(event) => onChange({ ...filters, [key]: event.target.checked })}
                />
                <span className="choice-text">{part}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Choices
          label="Stated Time at most"
          name={`${id}-time`}
          options={TIMES}
          value={filters.maxStatedSeconds}
          onChange={(maxStatedSeconds) => onChange({ ...filters, maxStatedSeconds })}
        />
        {/* showModal() makes the page's status line inert, so the count is announced from here. */}
        <p role="status" className="visually-hidden">
          {shown === 0
            ? "No recipes match"
            : `${shown} ${shown === 1 ? "recipe matches" : "recipes match"}`}
        </p>
        <div className="sheet-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => onChange(noFilters)}
          >
            Clear
          </button>
          <button type="button" className="button" onClick={() => setOpen(false)}>
            {matchCount(shown)}
          </button>
        </div>
      </Sheet>
    </>
  );
}

// A radio group drawn as pills, for picking one maximum or Any.
function Choices({
  label,
  name,
  options,
  value,
  onChange,
}: {
  label: string;
  name: string;
  options: [number | null, string][];
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <fieldset className="sheet-section">
      <legend>{label}</legend>
      <div className="choices">
        {options.map(([option, text]) => (
          <label key={text} className="choice">
            <input
              type="radio"
              className="visually-hidden"
              name={name}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <span className="choice-text">{text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
