import { useId, useRef } from "react";
import { activeFilterCount, type CardFilters, isChosen, noFilters, toggleTag } from "./cardFilters";
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
  const sheet = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const downOnBackdrop = useRef(false);
  const active = activeFilterCount(filters);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="button button-secondary"
        aria-haspopup="dialog"
        onClick={() => {
          sheet.current?.showModal();
          // Focus the title, so no control looks chosen before it's touched.
          title.current?.focus();
        }}
      >
        {active > 0 ? `Filters · ${active}` : "Filters"}
      </button>
      {/* The padding is on .sheet-body, so only a tap on the backdrop targets the dialog itself.
          Closing also needs the press to have begun there: a drag from a chip released on the backdrop
          clicks the dialog. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a tap on the backdrop; Escape closes it too. */}
      <dialog
        ref={sheet}
        className="sheet"
        aria-labelledby={`${id}-title`}
        onClose={() => button.current?.focus()}
        onPointerDown={(event) => {
          downOnBackdrop.current = event.target === event.currentTarget;
        }}
        onClick={(event) =>
          downOnBackdrop.current &&
          event.target === event.currentTarget &&
          event.currentTarget.close()
        }
      >
        <div className="sheet-body">
          <h2 ref={title} id={`${id}-title`} className="sheet-title" tabIndex={-1}>
            Filters
          </h2>
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
          <div className="sheet-section">
            <label className="check">
              <input
                type="checkbox"
                checked={filters.easyCleanup}
                aria-describedby={`${id}-cleanup`}
                onChange={(event) => onChange({ ...filters, easyCleanup: event.target.checked })}
              />
              Easy cleanup
            </label>
            <p id={`${id}-cleanup`} className="field-hint">
              Cleanup 1 of 3
            </p>
          </div>
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
            <button type="button" className="button" onClick={() => sheet.current?.close()}>
              {matchCount(shown)}
            </button>
          </div>
        </div>
      </dialog>
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
